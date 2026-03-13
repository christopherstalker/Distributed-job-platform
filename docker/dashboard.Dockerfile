FROM node:24-alpine AS builder
WORKDIR /app

ARG VITE_API_BASE_URL=http://localhost:8080
ARG VITE_ADMIN_TOKEN=dev-admin-token
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_ADMIN_TOKEN=${VITE_ADMIN_TOKEN}

COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard .
RUN npm run build

FROM nginx:1.29-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
