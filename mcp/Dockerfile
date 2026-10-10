# Build context: the repository root. Targets: server (default) and mockengine.
FROM golang:1.27-bookworm AS build
WORKDIR /src
COPY mcp/go.mod mcp/go.sum ./mcp/
RUN cd mcp && go mod download
COPY mcp/ ./mcp/
COPY contracts/ ./contracts/
RUN cd mcp && go test ./... \
    && CGO_ENABLED=0 go build -o /out/server ./cmd/server \
    && CGO_ENABLED=0 go build -o /out/mockengine ./cmd/mockengine

FROM gcr.io/distroless/static-debian12 AS mockengine
COPY --from=build /out/mockengine /mockengine
EXPOSE 7002
ENTRYPOINT ["/mockengine"]

FROM gcr.io/distroless/static-debian12 AS server
COPY --from=build /out/server /server
COPY contracts/ /app/contracts/
ENV CATALOGUE_PATH=/app/contracts/events.json \
    LISTEN_ADDR=:8080
EXPOSE 8080
ENTRYPOINT ["/server"]
