FROM golang:1.25-alpine AS builder
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY scheduler ./scheduler
COPY libs ./libs
COPY migrations ./migrations
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/scheduler ./scheduler

FROM alpine:3.22
WORKDIR /app
RUN adduser -D -H appuser
COPY --from=builder /out/scheduler /app/scheduler
USER appuser
EXPOSE 8080
ENTRYPOINT ["/app/scheduler"]
