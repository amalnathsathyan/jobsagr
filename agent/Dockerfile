FROM node:23-slim

WORKDIR /app

# Install system dependencies for Playwright
RUN apt-get update && apt-get install -y \
    libgbm-dev \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

# Install Playwright browsers
RUN npx playwright install --with-deps chromium

COPY . .

CMD ["npm", "start"]
