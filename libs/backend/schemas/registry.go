package schemas

import (
	"encoding/json"
	"fmt"
	"sync"
)

type ValidatorFunc func(json.RawMessage) error

type Registry struct {
	mu         sync.RWMutex
	validators map[string]map[int]ValidatorFunc
}

func NewRegistry() *Registry {
	return &Registry{
		validators: map[string]map[int]ValidatorFunc{},
	}
}

func (r *Registry) Register(jobType string, version int, validator ValidatorFunc) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if version <= 0 {
		version = 1
	}
	if r.validators[jobType] == nil {
		r.validators[jobType] = map[int]ValidatorFunc{}
	}
	r.validators[jobType][version] = validator
}

func (r *Registry) Validate(jobType string, version int, payload json.RawMessage) error {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if version <= 0 {
		version = 1
	}
	versions, ok := r.validators[jobType]
	if !ok {
		return nil
	}
	validator, ok := versions[version]
	if !ok {
		return fmt.Errorf("no schema registered for %s version %d", jobType, version)
	}
	return validator(payload)
}
