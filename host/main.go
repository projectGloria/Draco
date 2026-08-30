// Command draco-host is the native-messaging bridge between the browser
// extension and the Draco desktop app.
//
// It exists because Chrome hands its host process the stdio pair directly, and
// an Electron GUI-subsystem executable is not a reliable owner of that pair.
// This is a plain console binary instead: it reads Chrome's length-prefixed
// frames from stdin, relays them to Draco over a named pipe, and writes the
// reply back to stdout.
//
// Two rules matter more than anything else here:
//
//   - Nothing may ever be written to stdout except a protocol frame. stdout is
//     the channel; a stray fmt.Println would corrupt the stream and the
//     extension would see garbage.
//   - The app may not be running. Chrome starts this host on demand, so a cold
//     start has to launch Draco and wait for its pipe to appear.
//
// Deliberately stdlib-only, so `go build` works with no module downloads.
package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const (
	pipePath = `\\.\pipe\draco`

	// Chrome's own limit on a single native message.
	maxFrame = 64 * 1024 * 1024
	// Chrome limits native messages sent *to* the extension to 1MB.
	maxWriteFrame = 1024 * 1024

	// How long to keep trying after launching the app. A cold Electron start
	// on a slow disk is comfortably under this.
	coldStartBudget = 15 * time.Second
)

// hostConfig is written by the app next to the native-messaging manifest, so
// the host can find the executable regardless of where it was installed.
type hostConfig struct {
	AppPath string   `json:"appPath"`
	AppArgs []string `json:"appArgs"`
}

var logFile *os.File

func main() {
	openLog()
	defer closeLog()

	logf("host started (pid %d)", os.Getpid())

	conn := &connection{}
	defer conn.close()

	for {
		// Native messaging is request/reply: Chrome sends a frame and waits for
		// exactly one response. Keeping each pair together avoids racing a pipe
		// read against the goroutine that writes its matching request.
		msg, err := readFrame(os.Stdin)
		if err != nil {
			if errors.Is(err, io.EOF) {
				logf("browser closed the port; exiting")
			} else {
				logf("failed to read from stdin: %v", err)
			}
			return
		}

		// Health/configuration checks are passive. Chrome starts this small host
		// in order to perform them, but they must not in turn start the Electron
		// app merely because a page containing a video was opened.
		allowLaunch := shouldLaunchForMessage(msg)
		if err := conn.write(msg, allowLaunch); err != nil {
			logf("relay failed: %v", err)
			if err := writeFrame(os.Stdout, errorReply(err)); err != nil {
				logf("failed to write relay error to stdout: %v", err)
				return
			}
			continue
		}

		reply, err := conn.read()
		if err != nil {
			logf("failed to read from pipe: %v", err)
			if err := writeFrame(os.Stdout, errorReply(err)); err != nil {
				logf("failed to write pipe error to stdout: %v", err)
				return
			}
			continue
		}

		if err := writeFrame(os.Stdout, reply); err != nil {
			logf("failed to write to stdout: %v", err)
			os.Exit(1)
		}
	}
}

/* ------------------------------------------------------------------ */
/* Framing                                                             */
/* ------------------------------------------------------------------ */

func readFrame(r io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}

	length := binary.LittleEndian.Uint32(header[:])
	if length > maxFrame {
		return nil, fmt.Errorf("frame of %d bytes exceeds the limit", length)
	}

	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	return body, nil
}

func writeFrame(w io.Writer, body []byte) error {
	if uint64(len(body)) > uint64(maxWriteFrame) {
		return fmt.Errorf("frame of %d bytes exceeds the limit", len(body))
	}
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(body)))
	if _, err := writeAll(w, header[:]); err != nil {
		return err
	}
	_, err := writeAll(w, body)
	return err
}

func writeAll(w io.Writer, data []byte) (int, error) {
	total := 0
	for len(data) > 0 {
		n, err := w.Write(data)
		if n > 0 {
			total += n
			data = data[n:]
		}
		if err != nil {
			return total, err
		}
		if n == 0 {
			return total, io.ErrShortWrite
		}
	}
	return total, nil
}

func errorReply(err error) []byte {
	payload, mErr := json.Marshal(map[string]any{
		"ok":    false,
		"taken": false,
		"error": err.Error(),
	})
	if mErr != nil {
		return []byte(`{"ok":false,"taken":false,"error":"internal"}`)
	}
	return payload
}

func messageType(body []byte) string {
	var envelope struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(body, &envelope) != nil {
		return ""
	}
	return envelope.Type
}

func shouldLaunchForMessage(body []byte) bool {
	switch messageType(body) {
	case "download", "media", "youtube":
		return true
	default:
		return false
	}
}

/* ------------------------------------------------------------------ */
/* The pipe to Draco                                                   */
/* ------------------------------------------------------------------ */

type connection struct {
	mu   sync.Mutex
	pipe *os.File
}

func (c *connection) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pipe != nil {
		c.pipe.Close()
		c.pipe = nil
	}
}

func (c *connection) getPipe(allowLaunch bool) (*os.File, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.pipe != nil {
		return c.pipe, nil
	}

	if err := c.dialLocked(); err == nil {
		return c.pipe, nil
	}
	if !allowLaunch {
		return nil, errors.New("Draco is not running")
	}
	if err := c.launchAndDialLocked(); err != nil {
		return nil, err
	}
	return c.pipe, nil
}

func (c *connection) write(msg []byte, allowLaunch bool) error {
	p, err := c.getPipe(allowLaunch)
	if err != nil {
		return err
	}

	err = writeFrame(p, msg)
	if err != nil {
		c.close()
	}
	return err
}

func (c *connection) read() ([]byte, error) {
	p, err := c.getPipe(false)
	if err != nil {
		return nil, err
	}

	reply, err := readFrame(p)
	if err != nil {
		c.close()
	}
	return reply, err
}

// dial opens the named pipe.
func (c *connection) dialLocked() error {
	pipe, err := os.OpenFile(pipePath, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	c.pipe = pipe
	return nil
}

// launchAndDial retries the pipe after starting Draco.
func (c *connection) launchAndDialLocked() error {
	if err := launchApp(); err != nil {
		logf("could not launch the app: %v", err)
		// Keep retrying regardless: the app may simply be mid-startup, in which
		// case the pipe will appear without any help from us.
	}

	deadline := time.Now().Add(coldStartBudget)
	delay := 150 * time.Millisecond

	for time.Now().Before(deadline) {
		time.Sleep(delay)
		if err := c.dialLocked(); err == nil {
			logf("connected after cold start")
			return nil
		}
		if delay < 1*time.Second {
			delay *= 2
		}
	}

	return errors.New("Draco is not running and did not start in time")
}

func launchApp() error {
	cfg, err := appConfig()
	if err != nil {
		// Fallback to old behavior if config isn't found
		path, err := appPath()
		if err != nil {
			return err
		}
		cfg = hostConfig{AppPath: path}
	}

	logf("launching %s %v", cfg.AppPath, cfg.AppArgs)
	cmd := exec.Command(cfg.AppPath, cfg.AppArgs...)
	// Detach: the app must outlive this host process, which Chrome kills as
	// soon as the extension's port closes.
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008} // DETACHED_PROCESS
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// appConfig reads the location the app recorded for itself.
func appConfig() (hostConfig, error) {
	if dir, err := os.UserConfigDir(); err == nil {
		raw, err := os.ReadFile(filepath.Join(dir, "Draco", "host-config.json"))
		if err == nil {
			var cfg hostConfig
			if json.Unmarshal(raw, &cfg) == nil && cfg.AppPath != "" {
				if _, err := os.Stat(cfg.AppPath); err == nil {
					return cfg, nil
				}
			}
		}
	}
	return hostConfig{}, errors.New("could not find app path")
}

// appPath reads the location the app recorded for itself, falling back to a
// sibling executable for the portable layout.
func appPath() (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}

	// Packaged layout: <install>/resources/draco-host.exe next to <install>/Draco.exe
	candidate := filepath.Join(filepath.Dir(filepath.Dir(self)), "Draco.exe")
	if _, err := os.Stat(candidate); err == nil {
		return candidate, nil
	}

	return "", errors.New("could not locate Draco.exe")
}

/* ------------------------------------------------------------------ */
/* Logging - never to stdout                                           */
/* ------------------------------------------------------------------ */

func openLog() {
	dir, err := os.UserConfigDir()
	if err != nil {
		return
	}
	logDir := filepath.Join(dir, "Draco", "logs")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return
	}
	logFile, _ = os.OpenFile(
		filepath.Join(logDir, "host.log"),
		os.O_APPEND|os.O_CREATE|os.O_WRONLY,
		0o644,
	)
}

func closeLog() {
	if logFile != nil {
		logFile.Close()
	}
}

func logf(format string, args ...any) {
	if logFile == nil {
		return
	}
	fmt.Fprintf(logFile, "%s %s\n", time.Now().Format(time.RFC3339), fmt.Sprintf(format, args...))
}
