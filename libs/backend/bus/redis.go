package bus

import (
	"context"
	"encoding/json"

	"distributed-job-system/libs/backend/domain"
	"distributed-job-system/libs/backend/queue"

	"github.com/redis/go-redis/v9"
)

type EventBus interface {
	Publish(context.Context, domain.SystemEvent) error
	Subscribe(context.Context) *redis.PubSub
}

type RedisEventBus struct {
	client *redis.Client
}

func NewRedisEventBus(client *redis.Client) *RedisEventBus {
	return &RedisEventBus{client: client}
}

func (b *RedisEventBus) Publish(ctx context.Context, event domain.SystemEvent) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return b.client.Publish(ctx, queue.EventChannel(), payload).Err()
}

func (b *RedisEventBus) Subscribe(ctx context.Context) *redis.PubSub {
	return b.client.Subscribe(ctx, queue.EventChannel())
}
