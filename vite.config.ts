import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    https: false,
    headers: {
      // WebHID requires a secure context; use localhost (counts as secure)
    },
  },
})
