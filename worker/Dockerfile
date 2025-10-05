FROM mcr.microsoft.com/playwright:v1.46.0-jammy
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npx playwright install-deps && npx playwright install chromium
EXPOSE 3000
CMD ["node", "index.js"]
