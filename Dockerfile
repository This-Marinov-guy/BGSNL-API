# Use the latest Node.js LTS (Long Term Support) image
FROM node:22-alpine

# Install PM2 globally
RUN npm install -g pm2

# Set working directory to the root of the Express project
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application files
COPY . .

# Expose the port your app runs on
EXPOSE 3000

# Start the application with PM2
CMD ["pm2", "start", "/usr/src/app/ecosystem.config.cjs"]