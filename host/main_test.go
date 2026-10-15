package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPassiveMessagesNeverLaunchApp(t *testing.T) {
	for _, body := range [][]byte{
		[]byte(`{"type":"ping"}`),
		[]byte(`{"type":"config"}`),
		[]byte(`{"type":"youtubePrime"}`),
		[]byte(`not json`),
	} {
		if shouldLaunchForMessage(body) {
			t.Fatalf("passive message unexpectedly allowed app launch: %s", body)
		}
	}
}

func TestUserDownloadMessagesMayLaunchApp(t *testing.T) {
	// downloadBatch must stay here: a bulk "download all links" send is often
	// the first native message after the browser starts, so it cold-launches.
	for _, kind := range []string{"download", "downloadBatch", "media", "youtube"} {
		body := []byte(`{"type":"` + kind + `"}`)
		if !shouldLaunchForMessage(body) {
			t.Fatalf("%s message did not allow app launch", kind)
		}
	}
}

func TestBridgePipeOverrideIsLimitedToDisposableNames(t *testing.T) {
	t.Setenv("DRACO_SMOKE_PIPE", "")
	if got := bridgePipePath(); got != pipePath {
		t.Fatalf("default pipe changed: %q", got)
	}
	valid := `\\.\pipe\draco-smoke-12345678`
	t.Setenv("DRACO_SMOKE_PIPE", valid)
	if got := bridgePipePath(); got != valid {
		t.Fatalf("disposable pipe rejected: %q", got)
	}
	for _, bad := range []string{`\\.\pipe\draco`, `\\.\pipe\other-12345678`, `\\.\pipe\draco-smoke-ABCDEF12`} {
		t.Setenv("DRACO_SMOKE_PIPE", bad)
		if got := bridgePipePath(); got != "" {
			t.Fatalf("invalid smoke pipe accepted: %q", got)
		}
	}
}

func TestPathCanonicalization(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Skip("cannot determine executable")
	}
	clean := filepath.Clean(self)
	lower := strings.ToLower(clean)
	if !strings.EqualFold(clean, lower) {
		t.Fatalf("case-insensitive comparison failed: %q vs %q", clean, lower)
	}
}
