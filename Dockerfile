# Use a base image
FROM --platform=linux/amd64 node:18-alpine

# Set the working directory
WORKDIR /amazon-q-slack-gateway-0.2.0

COPY package.json .
COPY package-lock.json .
COPY tsconfig.json .

RUN npm install

RUN npm install tsconfig-paths --save-dev

# Copy the application code
COPY . .

# Install dependencies
# Expose the port the app runs on
EXPOSE 80

# Start the application
CMD ["npm", "start"]
