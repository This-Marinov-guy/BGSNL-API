# Use the Node.js image as a base
FROM node:22-alpine

# Set working directory
WORKDIR /

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application files
COPY . .

# Expose the port your app runs on (e.g., 3000)
EXPOSE 3000

# Start the application with PM2
CMD ["npx", "pm2-runtime", "ecosystem.config.js"]