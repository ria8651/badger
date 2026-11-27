// Runs in Badger's page inside the app, before its own scripts. It only says what the app can do; the page decides
// when to use it (src/app.ts).
;(() => {
  if (window.top !== window || window.badgerApp) return
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args).catch(() => {})

  const clicks = new Map()
  let nextId = 0
  window.badgerApp = {
    setBadge: (count) => invoke('set_badge', { count }),
    notify: (title, body, onClick) => {
      const id = ++nextId
      clicks.set(id, onClick)
      invoke('notify', { id, title, body })
    },
    startDrag: () => invoke('plugin:window|start_dragging'),
    toggleZoom: () => invoke('plugin:window|internal_toggle_maximize'),
    placeTrafficLights: (left, middle) => invoke('place_traffic_lights', { left, middle }),
  }
  // The app calls this once a notification is clicked or dismissed.
  window.__badgerNotification = (id, clicked) => {
    const onClick = clicks.get(id)
    clicks.delete(id)
    if (clicked) onClick?.()
  }
})()
