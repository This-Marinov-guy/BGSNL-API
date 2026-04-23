# Use LTS version
FROM node:20-alpine

# Install fontconfig so Sharp/Pango can resolve custom fonts
RUN apk add --no-cache fontconfig

# Install PM2 globally
RUN npm install -g pm2

# Set working directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application files
COPY . .

# Register bundled fonts inside the container
RUN mkdir -p /usr/share/fonts/bgsnl \
  && cp -r /usr/src/app/assets/fonts/. /usr/share/fonts/bgsnl/ \
  && fc-cache -f

# Create logs directory
RUN mkdir -p /usr/src/app/logs

# Set proper permissions
RUN chown -R node:node /usr/src/app

# Switch to non-root user
USER node

# Expose the port
EXPOSE 3000

# Start with PM2
CMD ["pm2-runtime", "start", "ecosystem.config.cjs"]
