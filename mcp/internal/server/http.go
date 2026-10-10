package server

import (
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/catalogue"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/core"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/files"
)

const maxUploadBytes = 64 << 20

// Handler returns the full HTTP surface: /mcp for agents and /api for the UI.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/mcp", s.MCPHandler())
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /api/whoami", s.auth(s.handleWhoami))
	mux.HandleFunc("GET /api/tools", s.auth(s.handleListTools))
	mux.HandleFunc("POST /api/tools/{name}", s.auth(s.handleCallTool))
	mux.HandleFunc("POST /api/files", s.auth(s.handleUpload))
	mux.HandleFunc("GET /api/files/{hash}", s.auth(s.handleDownload))
	mux.HandleFunc("GET /api/stream", s.auth(s.handleStream))
	return s.cors(mux)
}

func (s *Server) identityOf(r *http.Request) (core.Identity, bool) {
	token := ""
	if h := r.Header.Get("Authorization"); strings.HasPrefix(strings.ToLower(h), "bearer ") {
		token = strings.TrimSpace(h[7:])
	}
	// EventSource and plain download links cannot set headers.
	if token == "" && r.Method == http.MethodGet {
		token = r.URL.Query().Get("token")
	}
	if token == "" {
		return core.Identity{}, false
	}
	return s.Identify(token)
}

type authed func(w http.ResponseWriter, r *http.Request, id core.Identity)

func (s *Server) auth(next authed) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := s.identityOf(r)
		if !ok {
			w.Header().Set("WWW-Authenticate", `Bearer realm="sanchay"`)
			writeError(w, &core.ToolError{
				Code:     core.CodePermissionDenied,
				Message:  "A valid bearer token is required.",
				NextStep: "Send the header Authorization: Bearer <token>.",
				Status:   http.StatusUnauthorized,
			})
			return
		}
		next(w, r, id)
	}
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.corsOrigin != "" && strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Access-Control-Allow-Origin", s.corsOrigin)
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-File-Name")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Expose-Headers", "Content-Disposition")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, terr *core.ToolError) {
	writeJSON(w, terr.HTTPStatus(), map[string]any{"ok": false, "error": terr})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"status": "ok", "version": serverVersion}
	if s.health != nil {
		out["services"] = s.health(r.Context())
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleWhoami(w http.ResponseWriter, _ *http.Request, id core.Identity) {
	writeJSON(w, http.StatusOK, describe(id))
}

// describe is the public form of an identity. The department appears only for
// a client employee who belongs to one.
func describe(id core.Identity) map[string]any {
	out := map[string]any{"user": id.User, "role": id.Role}
	if id.Department != "" {
		out["department"] = id.Department
		out["department_name"] = core.DepartmentName(id.Department)
	}
	return out
}

func (s *Server) handleListTools(w http.ResponseWriter, _ *http.Request, id core.Identity) {
	list := []map[string]any{}
	for _, t := range s.ToolsFor(id) {
		list = append(list, map[string]any{
			"name":         t.Name,
			"group":        t.Group,
			"description":  t.Description,
			"write":        t.Write,
			"input_schema": catalogue.Schema(t.Fields),
		})
	}
	out := describe(id)
	out["tools"] = list
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCallTool(w http.ResponseWriter, r *http.Request, id core.Identity) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxUploadBytes*2))
	if err != nil {
		writeError(w, core.Errf(core.CodeValidationFailed, "Send a smaller request, or upload files with POST /api/files.", "The request body could not be read: %v", err))
		return
	}
	ctx := r.Context()
	// Seeding a historical business: the record time of each event may be supplied,
	// for client identities only and only when the server runs with SIM_CLOCK=1.
	if t := r.Header.Get("X-Sim-Recorded-At"); t != "" && os.Getenv("SIM_CLOCK") == "1" && id.Role == core.RoleClient {
		ctx = core.WithSimTime(ctx, t)
	}
	result, terr := s.Invoke(ctx, id, r.PathValue("name"), raw)
	if terr != nil {
		writeError(w, terr)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": result})
}

// handleUpload stores a file and returns its hash. It accepts a multipart
// form with a "file" part, or the raw bytes with the name in X-File-Name.
// Storing a file changes no business data; the upload tools do that.
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request, _ core.Identity) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	var data []byte
	var name, contentType string
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		file, header, err := r.FormFile("file")
		if err != nil {
			writeError(w, core.Errf(core.CodeValidationFailed, "Send the file in a form part named file.", "No file part was found: %v", err))
			return
		}
		defer file.Close()
		data, err = io.ReadAll(file)
		if err != nil {
			writeError(w, core.Internal(err))
			return
		}
		name = header.Filename
		contentType = header.Header.Get("Content-Type")
	} else {
		var err error
		data, err = io.ReadAll(r.Body)
		if err != nil {
			writeError(w, core.Errf(core.CodeValidationFailed, "Files up to 64 MB are accepted.", "The file could not be read: %v", err))
			return
		}
		name = r.Header.Get("X-File-Name")
		contentType = r.Header.Get("Content-Type")
	}
	if len(data) == 0 {
		writeError(w, core.Errf(core.CodeValidationFailed, "Send a non-empty file.", "The file is empty."))
		return
	}
	if name == "" {
		name = "upload"
	}
	meta, err := s.files.Put(r.Context(), data, name, contentType)
	if err != nil {
		writeError(w, core.Internal(err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": map[string]any{
		"file_hash": meta.Hash, "file_name": name, "size": len(data),
	}})
}

func (s *Server) handleDownload(w http.ResponseWriter, r *http.Request, _ core.Identity) {
	data, meta, err := s.files.Get(r.Context(), r.PathValue("hash"))
	if err == files.ErrNotFound {
		writeError(w, core.Errf(core.CodeNotFound, "Check the file_hash.", "No stored file has that hash."))
		return
	}
	if err != nil {
		writeError(w, core.Internal(err))
		return
	}
	name := r.URL.Query().Get("name")
	if name == "" {
		name = meta.Name
	}
	if name == "" {
		name = meta.Hash
	}
	contentType := meta.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	w.Header().Set("Content-Length", fmt.Sprint(len(data)))
	_, _ = w.Write(data)
}

// handleStream is the Server-Sent Events channel to the UI.
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request, id core.Identity) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "event: ready\ndata: {\"user\":%q,\"role\":%q}\n\n", id.User, id.Role)
	flusher.Flush()

	ch, cancel := s.hub.Subscribe(id.Role)
	defer cancel()
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			fmt.Fprint(w, ": keep-alive\n\n")
			flusher.Flush()
		case n := <-ch:
			body, err := json.Marshal(n)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", n.Kind, body)
			flusher.Flush()
		}
	}
}
