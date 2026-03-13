package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDashboardRedirectTarget(t *testing.T) {
	server := &Server{
		dashboardOrigin: "http://localhost:3000",
	}

	tests := []struct {
		name     string
		path     string
		accept   string
		expected string
		ok       bool
	}{
		{
			name:     "root redirects to dashboard",
			path:     "/",
			accept:   "text/html",
			expected: "http://localhost:3000/",
			ok:       true,
		},
		{
			name:     "asset redirects to dashboard asset",
			path:     "/assets/index.js",
			accept:   "*/*",
			expected: "http://localhost:3000/assets/index.js",
			ok:       true,
		},
		{
			name:   "api path does not redirect",
			path:   "/api/v1/dashboard",
			accept: "application/json",
			ok:     false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, test.path, nil)
			req.Header.Set("Accept", test.accept)

			target, ok := server.dashboardRedirectTarget(req)
			if ok != test.ok {
				t.Fatalf("expected ok=%v, got %v", test.ok, ok)
			}
			if target != test.expected {
				t.Fatalf("expected target %q, got %q", test.expected, target)
			}
		})
	}
}
