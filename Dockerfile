FROM mcr.microsoft.com/playwright:v1.48.2-jammy

WORKDIR /app

# Install only prod deps
COPY package*.json ./
RUN npm install --only=production

# Ensure Chromium is installed in the path Playwright expects
# This avoids the "Executable doesn't exist" error at runtime.
RUN npx playwright install chromium

# Copy app code
COPY . .

# Render provides PORT
ENV PORT=10000

CMD ["npm","start"]
