FROM golang:1.25-alpine AS builder
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY api ./api
COPY libs ./libs
COPY migrations ./migrations
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/api ./api

FROM alpine:3.22
WORKDIR /app
RUN adduser -D -H appuser
COPY --from=builder /out/api /app/api
COPY --from=builder /src/migrations /app/migrations
USER appuser
EXPOSE 8080
ENTRYPOINT ["/app/api"]
