FROM golang:1.25-alpine AS builder
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY worker ./worker
COPY libs ./libs
COPY migrations ./migrations
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/worker ./worker

FROM alpine:3.22
WORKDIR /app
RUN adduser -D -H appuser
COPY --from=builder /out/worker /app/worker
USER appuser
EXPOSE 8080
ENTRYPOINT ["/app/worker"]
