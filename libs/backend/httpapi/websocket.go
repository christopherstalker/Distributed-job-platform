package httpapi

import (
	"bufio"
	"context"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

type Hub struct {
	log           *slog.Logger
	upgrader      websocket.Upgrader
	mu            sync.Mutex
	socketClients map[*websocket.Conn]struct{}
	streamClients map[chan []byte]struct{}
}

func NewHub(log *slog.Logger, dashboardOrigin string) *Hub {
	allowedOrigins := allowedWebSocketOrigins(dashboardOrigin)
	return &Hub{
		log: log,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				if len(allowedOrigins) == 0 {
					return true
				}
				origin := r.Header.Get("Origin")
				for _, allowedOrigin := range allowedOrigins {
					if origin == allowedOrigin {
						return true
					}
				}
				return false
			},
		},
		socketClients: map[*websocket.Conn]struct{}{},
		streamClients: map[chan []byte]struct{}{},
	}
}

func (h *Hub) Register(w http.ResponseWriter, r *http.Request) error {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return err
	}
	h.mu.Lock()
	h.socketClients[conn] = struct{}{}
	h.mu.Unlock()

	conn.SetReadLimit(1024)
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		return nil
	})

	done := make(chan struct{})
	go func() {
		defer close(done)
		defer h.unregister(conn)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	go func() {
		pingTicker := time.NewTicker(15 * time.Second)
		defer pingTicker.Stop()
		for {
			select {
			case <-done:
				return
			case <-pingTicker.C:
				_ = conn.WriteControl(websocket.PingMessage, []byte("ping"), time.Now().Add(5*time.Second))
			}
		}
	}()
	return nil
}

func (h *Hub) RegisterSSE(w http.ResponseWriter, r *http.Request) error {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return http.ErrNotSupported
	}
	writer := bufio.NewWriter(w)
	stream := make(chan []byte, 32)
	h.registerStream(stream)
	defer h.unregisterStream(stream)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	if _, err := writer.WriteString(": connected\n\n"); err != nil {
		return err
	}
	if err := writer.Flush(); err != nil {
		return err
	}
	flusher.Flush()

	keepAlive := time.NewTicker(15 * time.Second)
	defer keepAlive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return nil
		case payload, ok := <-stream:
			if !ok {
				return nil
			}
			if _, err := writer.Write(writeSSEPayload(payload)); err != nil {
				return err
			}
			if err := writer.Flush(); err != nil {
				return err
			}
			flusher.Flush()
		case <-keepAlive.C:
			if _, err := writer.WriteString(": ping\n\n"); err != nil {
				return err
			}
			if err := writer.Flush(); err != nil {
				return err
			}
			flusher.Flush()
		}
	}
}

func (h *Hub) Run(ctx context.Context, pubsub *redis.PubSub) {
	ch := pubsub.Channel()
	for {
		select {
		case <-ctx.Done():
			_ = pubsub.Close()
			h.closeAll()
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			h.broadcast([]byte(msg.Payload))
		}
	}
}

func (h *Hub) broadcast(payload []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for conn := range h.socketClients {
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
			_ = conn.Close()
			delete(h.socketClients, conn)
		}
	}
	for stream := range h.streamClients {
		select {
		case stream <- append([]byte(nil), payload...):
		default:
			close(stream)
			delete(h.streamClients, stream)
		}
	}
}

func (h *Hub) unregister(conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.socketClients[conn]; !ok {
		return
	}
	delete(h.socketClients, conn)
	_ = conn.Close()
}

func (h *Hub) closeAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for conn := range h.socketClients {
		_ = conn.Close()
		delete(h.socketClients, conn)
	}
	for stream := range h.streamClients {
		close(stream)
		delete(h.streamClients, stream)
	}
}

func (h *Hub) registerStream(stream chan []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.streamClients[stream] = struct{}{}
}

func (h *Hub) unregisterStream(stream chan []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.streamClients[stream]; !ok {
		return
	}
	delete(h.streamClients, stream)
	close(stream)
}

func allowedWebSocketOrigins(configuredOrigin string) []string {
	origins := []string{
		"http://localhost:3000",
		"http://127.0.0.1:3000",
	}
	if configuredOrigin != "" {
		origins = append(origins, configuredOrigin)
		if parsed, err := url.Parse(configuredOrigin); err == nil {
			switch parsed.Hostname() {
			case "localhost":
				origins = append(origins, "http://127.0.0.1:3000")
			case "127.0.0.1":
				origins = append(origins, "http://localhost:3000")
			}
		}
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(origins))
	for _, origin := range origins {
		if origin == "" {
			continue
		}
		if _, ok := seen[origin]; ok {
			continue
		}
		seen[origin] = struct{}{}
		out = append(out, origin)
	}
	return out
}

func writeSSEPayload(payload []byte) []byte {
	return append([]byte("event: system\ndata: "), append(payload, []byte("\n\n")...)...)
}
