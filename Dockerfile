# Use an official Node.js runtime as the base image
FROM node:18
# Install ffmpeg and clean up apt cache to reduce image size
RUN apt-get update && \
    apt-get install -y apt-transport-https && \
    apt-get install -y ffmpeg || apt-get --fix-missing install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install app dependencies
RUN npm install

# Copy the rest of the application code
COPY . .
# Create a directory for media files
RUN mkdir -p media

# Expose the port the app runs on
EXPOSE 3000

# Define the command to run the app
CMD ["node", "server.js"]