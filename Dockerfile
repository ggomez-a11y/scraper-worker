FROM mcr.microsoft.com/playwright:v1.48.2-jammy

# Point Playwright to the browsers already baked into this image
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_DOWNLOAD=1

WORKDIR /app
COPY package*.json ./
RUN npm install --only=production
COPY . .

ENV PORT=10000
CMD ["npm","start"]
