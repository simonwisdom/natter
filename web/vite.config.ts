import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/ws': { target: 'ws://127.0.0.1:8777', ws: true }, '/lab-recording': 'http://127.0.0.1:8777', '/lab-replay': 'http://127.0.0.1:8777' },
  },
  // Three pages: the Natter app, the Body Lab test bench at /lab.html, and the replay viewer at /replay.html.
  build: { rollupOptions: { input: { main: 'index.html', lab: 'lab.html', replay: 'replay.html' } } },
})
