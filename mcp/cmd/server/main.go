// Command server runs the MCP server and the HTTP gateway for the UI.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/catalogue"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/core"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/engine"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/files"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/ledger"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/server"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/store"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/tools"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// loadIdentities maps bearer tokens to identities. A JSON file given in
// IDENTITIES_FILE takes precedence; otherwise one token per role is read from
// the environment, with development defaults.
func loadIdentities() (map[string]core.Identity, error) {
	out := map[string]core.Identity{}
	if path := os.Getenv("IDENTITIES_FILE"); path != "" {
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		var list []struct {
			Token      string `json:"token"`
			User       string `json:"user"`
			Role       string `json:"role"`
			Department string `json:"department"`
		}
		if err := json.Unmarshal(raw, &list); err != nil {
			return nil, fmt.Errorf("parse %s: %w", path, err)
		}
		for _, item := range list {
			switch item.Role {
			case core.RoleClient, core.RoleAuditor, core.RoleManager:
			default:
				return nil, fmt.Errorf("identity %s has unknown role %q", item.User, item.Role)
			}
			if item.Token == "" || item.User == "" {
				return nil, errors.New("every identity needs a token and a user")
			}
			if item.Department != "" && (item.Role != core.RoleClient || core.DepartmentName(item.Department) == "") {
				return nil, fmt.Errorf("identity %s has department %q: a department must be one of sales, dispatch, accounts or admin, on a client_employee", item.User, item.Department)
			}
			out[item.Token] = core.Identity{User: item.User, Role: item.Role, Department: item.Department}
		}
		return out, nil
	}
	out[env("TOKEN_CLIENT", "client-demo-token")] = core.Identity{User: env("USER_CLIENT", "client.employee"), Role: core.RoleClient}
	// One demo employee per client department. The token above belongs to no department and is not restricted.
	for _, d := range core.Departments {
		token := env("TOKEN_"+strings.ToUpper(d.ID), d.ID+"-demo-token")
		out[token] = core.Identity{User: d.ID + ".employee", Role: core.RoleClient, Department: d.ID}
	}
	out[env("TOKEN_AUDITOR", "auditor-demo-token")] = core.Identity{User: env("USER_AUDITOR", "auditor.agent"), Role: core.RoleAuditor}
	out[env("TOKEN_MANAGER", "manager-demo-token")] = core.Identity{User: env("USER_MANAGER", "audit.manager"), Role: core.RoleManager}
	return out, nil
}

func main() {
	stdio := flag.Bool("stdio", false, "serve MCP over standard input and output instead of HTTP")
	token := flag.String("token", "", "bearer token of the identity to use in stdio mode")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(logger, *stdio, *token); err != nil {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger, stdio bool, token string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cat, err := catalogue.Load(env("CATALOGUE_PATH", "../contracts/events.json"))
	if err != nil {
		return err
	}
	identities, err := loadIdentities()
	if err != nil {
		return err
	}

	db, err := store.Open(ctx, env("DATABASE_URL", "postgres://mcp_read:mcp_read@localhost:5432/audit"))
	if err != nil {
		return fmt.Errorf("database: %w", err)
	}
	defer db.Close()

	var fileStore files.Store
	switch env("OBJECT_STORE", "dir") {
	case "s3":
		fileStore, err = files.NewS3(ctx, files.S3Config{
			Endpoint:  env("S3_ENDPOINT", "minio:9000"),
			AccessKey: env("S3_ACCESS_KEY", "minioadmin"),
			SecretKey: env("S3_SECRET_KEY", "minioadmin"),
			Bucket:    env("S3_BUCKET", "audit-files"),
			Secure:    env("S3_SECURE", "false") == "true",
		})
	default:
		fileStore, err = files.NewDir(env("FILES_DIR", "./data/files"))
	}
	if err != nil {
		return fmt.Errorf("file store: %w", err)
	}

	serviceToken := env("SERVICE_TOKEN", "dev-service-token")
	ledgerClient := ledger.New(env("LEDGER_URL", "http://localhost:7001"), serviceToken)
	engineClient := engine.New(env("ENGINE_URL", "http://localhost:7002"), serviceToken)

	deps := &tools.Deps{
		Cat:           cat,
		Ledger:        ledgerClient,
		Engine:        engineClient,
		Store:         db,
		Files:         fileStore,
		DefaultEntity: env("DEFAULT_ENTITY", "E1"),
	}
	srv := server.New(server.Options{
		Catalogue:  cat,
		Ledger:     ledgerClient,
		Files:      fileStore,
		Tools:      tools.Build(deps),
		Identities: identities,
		Logger:     logger,
		CORSOrigin: env("CORS_ORIGIN", "*"),
		Stateful:   env("MCP_STATEFUL", "false") == "true",
		Health: func(ctx context.Context) map[string]any {
			hctx, cancel := context.WithTimeout(ctx, 3*time.Second)
			defer cancel()
			return map[string]any{
				"database": db.Ping(hctx) == nil,
				"ledger":   ledgerClient.Health(hctx),
				"engine":   engineClient.Health(hctx),
			}
		},
	})

	if stdio {
		id, ok := srv.Identify(token)
		if !ok {
			return errors.New("stdio mode needs --token set to a known identity token")
		}
		logger.Info("serving MCP over stdio", "user", id.User, "role", id.Role)
		return srv.RunStdio(ctx, id)
	}

	addr := env("LISTEN_ADDR", ":8080")
	httpServer := &http.Server{Addr: addr, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()
	logger.Info("serving", "addr", addr, "mcp", "/mcp", "api", "/api", "identities", len(identities))
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
