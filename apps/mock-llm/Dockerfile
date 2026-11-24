FROM node:24-slim

WORKDIR /app

COPY package.json ./
COPY apps/mock-llm/package.json ./apps/mock-llm/

RUN npm install --workspace @cacheroute/mock-llm --include-workspace-root=false

COPY tsconfig.base.json ./
COPY apps/mock-llm/tsconfig.json ./apps/mock-llm/
COPY apps/mock-llm/src ./apps/mock-llm/src

RUN npm --workspace @cacheroute/mock-llm run build

EXPOSE 8081
ENV PORT=8081
CMD ["node", "apps/mock-llm/dist/server.js"]
