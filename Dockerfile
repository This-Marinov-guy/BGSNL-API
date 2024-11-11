# Dockerfile
# ==================
FROM node:22-alpine

# Install PM2 globally
RUN npm install -g pm2

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application files
COPY . .

# Expose the port your app runs on
EXPOSE 3000

# Create PM2 ecosystem file
RUN echo '{\
  "apps": [{\
    "name": "express-app",\
    "script": "src/index.js",\
    "instances": "max",\
    "exec_mode": "cluster",\
    "env": {\
      "NODE_ENV": "production"\
    }\
  }]\
}' > ecosystem.config.cjs

# Start PM2
CMD ["pm2-runtime", "ecosystem.config.cjs"]