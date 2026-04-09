FROM node:23-slim

WORKDIR /app

# Install system deps for Playwright chromium
RUN apt-get update && apt-get install -y \
    libgbm-dev \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Install ElizaOS CLI globally
RUN npm install -g @elizaos/cli

COPY package*.json ./
RUN npm install

# Install Playwright browsers
RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 3000

CMD ["elizaos", "start", "--character", "./characters/agent.character.json"]
