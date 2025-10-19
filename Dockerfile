FROM mcr.microsoft.com/playwright:v1.48.2-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=10000
CMD ["npm","start"]
