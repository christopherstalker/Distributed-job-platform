package processors

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"distributed-job-system/libs/backend/domain"
)

type Handler interface {
	Handle(context.Context, domain.Job) (json.RawMessage, error)
}

type HandlerFunc func(context.Context, domain.Job) (json.RawMessage, error)

func (f HandlerFunc) Handle(ctx context.Context, job domain.Job) (json.RawMessage, error) {
	return f(ctx, job)
}

type Registry struct {
	mu       sync.RWMutex
	handlers map[string]Handler
}

func NewRegistry() *Registry {
	return &Registry{handlers: map[string]Handler{}}
}

func (r *Registry) Register(name string, handler Handler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.handlers[name] = handler
}

func (r *Registry) Resolve(name string) (Handler, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	handler, ok := r.handlers[name]
	if !ok {
		return nil, fmt.Errorf("no handler registered for %s", name)
	}
	return handler, nil
}
