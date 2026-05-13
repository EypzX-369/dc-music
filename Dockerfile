# Use a lightweight Node.js image
FROM node:20-slim

# Install FFmpeg and build dependencies for audio processing
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the bot code
COPY . .

# Start the bot
CMD [ "node", "index.js" ]
