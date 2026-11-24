FROM node:24-slim

WORKDIR /app

ENV npm_config_onnxruntime_node_install_cuda=skip

COPY .npmrc package.json ./
COPY apps/gateway/package.json ./apps/gateway/

RUN npm install --workspace @cacheroute/gateway --include-workspace-root=false

COPY tsconfig.base.json ./
COPY apps/gateway/tsconfig.json ./apps/gateway/
COPY apps/gateway/tsconfig.build.json ./apps/gateway/
COPY apps/gateway/scripts ./apps/gateway/scripts
COPY apps/gateway/src ./apps/gateway/src

RUN npm --workspace @cacheroute/gateway run build

EXPOSE 3000
ENV PORT=3000
CMD ["node", "apps/gateway/dist/server.js"]
