FROM mcr.microsoft.com/playwright:v1.56.1-jammy

# Use the browsers already baked into this image
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_DOWNLOAD=1

WORKDIR /app

# Install prod deps
COPY package*.json ./
RUN npm install --only=production

# App code
COPY . .

# Render provides PORT
ENV PORT=10000
CMD ["npm","start"]
