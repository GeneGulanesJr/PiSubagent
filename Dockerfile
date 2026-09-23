FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY agents ./agents
COPY prompts ./prompts
COPY skills ./skills
COPY test ./test
CMD ["npm", "test"]
