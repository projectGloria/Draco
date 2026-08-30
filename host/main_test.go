package main

import "testing"

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
	for _, kind := range []string{"download", "media", "youtube"} {
		body := []byte(`{"type":"` + kind + `"}`)
		if !shouldLaunchForMessage(body) {
			t.Fatalf("%s message did not allow app launch", kind)
		}
	}
}
