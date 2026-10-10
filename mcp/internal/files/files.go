// Package files stores uploaded and generated files by their SHA-256 hash.
// Two backends share one layout so the audit engine can read what the MCP
// server writes: the object key is the hash in lower-case hexadecimal, and
// the file name and content type travel as metadata.
package files

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Meta describes a stored file.
type Meta struct {
	Hash        string `json:"file_hash"`
	Name        string `json:"file_name"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
}

// Store is a content-addressed file store.
type Store interface {
	Put(ctx context.Context, data []byte, name, contentType string) (Meta, error)
	Get(ctx context.Context, hash string) ([]byte, Meta, error)
	Stat(ctx context.Context, hash string) (Meta, error)
}

// ErrNotFound is returned when no file has the given hash.
var ErrNotFound = errors.New("file not found")

var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ValidHash reports whether s is a SHA-256 in lower-case hexadecimal.
func ValidHash(s string) bool { return hashPattern.MatchString(s) }

// Sum returns the SHA-256 of data in hexadecimal.
func Sum(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// ---------------------------------------------------------------------------
// Local directory backend

type dirStore struct{ root string }

// NewDir returns a store rooted at a local directory.
func NewDir(root string) (Store, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	return &dirStore{root: root}, nil
}

func (d *dirStore) path(hash string) string { return filepath.Join(d.root, hash[:2], hash) }

func (d *dirStore) Put(_ context.Context, data []byte, name, contentType string) (Meta, error) {
	m := Meta{Hash: Sum(data), Name: name, ContentType: contentType, Size: int64(len(data))}
	p := d.path(m.Hash)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return m, err
	}
	if _, err := os.Stat(p); err == nil {
		// Same content is already stored. Keep the first metadata.
		if existing, err := d.Stat(context.Background(), m.Hash); err == nil {
			return existing, nil
		}
	}
	if err := os.WriteFile(p, data, 0o644); err != nil {
		return m, err
	}
	mb, _ := json.Marshal(m)
	if err := os.WriteFile(p+".json", mb, 0o644); err != nil {
		return m, err
	}
	return m, nil
}

func (d *dirStore) Stat(_ context.Context, hash string) (Meta, error) {
	if !ValidHash(hash) {
		return Meta{}, ErrNotFound
	}
	mb, err := os.ReadFile(d.path(hash) + ".json")
	if err != nil {
		if info, statErr := os.Stat(d.path(hash)); statErr == nil {
			return Meta{Hash: hash, Size: info.Size()}, nil
		}
		return Meta{}, ErrNotFound
	}
	var m Meta
	if err := json.Unmarshal(mb, &m); err != nil {
		return Meta{}, err
	}
	return m, nil
}

func (d *dirStore) Get(ctx context.Context, hash string) ([]byte, Meta, error) {
	m, err := d.Stat(ctx, hash)
	if err != nil {
		return nil, m, err
	}
	data, err := os.ReadFile(d.path(hash))
	if err != nil {
		return nil, m, ErrNotFound
	}
	return data, m, nil
}

// ---------------------------------------------------------------------------
// S3-compatible backend (MinIO)

type s3Store struct {
	client *minio.Client
	bucket string
}

// S3Config configures the S3-compatible backend.
type S3Config struct {
	Endpoint  string
	AccessKey string
	SecretKey string
	Bucket    string
	Secure    bool
}

// NewS3 returns a store backed by an S3-compatible service. The bucket is
// created when it does not exist.
func NewS3(ctx context.Context, cfg S3Config) (Store, error) {
	client, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: cfg.Secure,
	})
	if err != nil {
		return nil, err
	}
	exists, err := client.BucketExists(ctx, cfg.Bucket)
	if err != nil {
		return nil, fmt.Errorf("object store: %w", err)
	}
	if !exists {
		if err := client.MakeBucket(ctx, cfg.Bucket, minio.MakeBucketOptions{}); err != nil {
			return nil, fmt.Errorf("object store: %w", err)
		}
	}
	return &s3Store{client: client, bucket: cfg.Bucket}, nil
}

func (s *s3Store) Put(ctx context.Context, data []byte, name, contentType string) (Meta, error) {
	m := Meta{Hash: Sum(data), Name: name, ContentType: contentType, Size: int64(len(data))}
	if existing, err := s.Stat(ctx, m.Hash); err == nil {
		return existing, nil
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	_, err := s.client.PutObject(ctx, s.bucket, m.Hash, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{
		ContentType:  contentType,
		UserMetadata: map[string]string{"file-name": name},
	})
	return m, err
}

func (s *s3Store) Stat(ctx context.Context, hash string) (Meta, error) {
	if !ValidHash(hash) {
		return Meta{}, ErrNotFound
	}
	info, err := s.client.StatObject(ctx, s.bucket, hash, minio.StatObjectOptions{})
	if err != nil {
		return Meta{}, ErrNotFound
	}
	name := info.UserMetadata["File-Name"]
	if name == "" {
		name = info.UserMetadata["file-name"]
	}
	return Meta{Hash: hash, Name: name, ContentType: info.ContentType, Size: info.Size}, nil
}

func (s *s3Store) Get(ctx context.Context, hash string) ([]byte, Meta, error) {
	m, err := s.Stat(ctx, hash)
	if err != nil {
		return nil, m, err
	}
	obj, err := s.client.GetObject(ctx, s.bucket, hash, minio.GetObjectOptions{})
	if err != nil {
		return nil, m, ErrNotFound
	}
	defer obj.Close()
	data, err := io.ReadAll(obj)
	if err != nil {
		return nil, m, err
	}
	return data, m, nil
}
