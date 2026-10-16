package main

import (
  "context"
  "net/http"
  "os"
  "regexp"
  "time"
  "github.com/teslamotors/vehicle-command/pkg/protocol"
  "github.com/teslamotors/vehicle-command/pkg/proxy"
)

func main() {
  // Only the private Cloudflare service binding can reach this container.
  // The command key enters at runtime and is never included in the image.
  path := "/tmp/command-key.pem"
  if os.WriteFile(path, []byte(os.Getenv("TESLA_PRIVATE_KEY")), 0600) != nil { os.Exit(1) }
  key, err := protocol.LoadPrivateKey(path)
  os.Remove(path)
  os.Unsetenv("TESLA_PRIVATE_KEY")
  if err != nil { os.Exit(1) }
  handler, err := proxy.New(context.Background(), key, 100)
  if err != nil { os.Exit(1) }
  handler.Timeout = 15 * time.Second
  route := regexp.MustCompile(`^/api/1/vehicles/[A-HJ-NPR-Z0-9]{17}/command/(charge_start|charge_stop|set_charge_limit|set_charging_amps|auto_conditioning_start|auto_conditioning_stop|set_temps|door_lock|door_unlock|set_sentry_mode|charge_port_door_open|charge_port_door_close|flash_lights|honk_horn)$`)
  server := &http.Server{Addr: ":8080", ReadHeaderTimeout: 5*time.Second, ReadTimeout: 10*time.Second, WriteTimeout: 25*time.Second, IdleTimeout: 30*time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    if r.Method == "GET" && r.URL.Path == "/health" { w.Write([]byte("OK")); return }
    if r.Method != "POST" || !route.MatchString(r.URL.Path) { http.NotFound(w, r); return }
    r.Body = http.MaxBytesReader(w, r.Body, 4096)
    handler.ServeHTTP(w, r)
  })}
  if server.ListenAndServe() != nil { os.Exit(1) }
}
