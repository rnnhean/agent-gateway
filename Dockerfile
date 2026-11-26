# ---- 阶段 1：构建 React 前端 ----
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
RUN npm run build

# ---- 阶段 2：运行服务（零依赖，只需要 node）----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8794 \
    WEB_DIST_DIR=/app/web/dist

COPY package.json ./
COPY src ./src
COPY --from=web /web/dist ./web/dist

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 8794

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8794)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
