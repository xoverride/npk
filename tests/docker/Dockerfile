# NPK Restore Functionality E2E Test Environment
FROM ubuntu:22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install basic dependencies including Docker CLI
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    cmake \
    p7zip-full \
    libssl-dev \
    libcurl4-openssl-dev \
    libhwloc-dev \
    ocl-icd-opencl-dev \
    pocl-opencl-icd \
    awscli \
    jq \
    uuid-runtime \
    ca-certificates \
    gnupg \
    lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update \
    && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 18.x
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Hashcat
WORKDIR /tmp
RUN wget https://hashcat.net/files/hashcat-6.2.6.7z \
    && 7z x hashcat-6.2.6.7z \
    && mv hashcat-6.2.6 /root/hashcat \
    && chmod +x /root/hashcat/hashcat.bin \
    && rm hashcat-6.2.6.7z

# Create working directory
WORKDIR /app

# Create necessary directories
RUN mkdir -p /root \
    /potfiles \
    /root/npk-rules \
    /root/npk-wordlist \
    /test-data \
    /test-results

# Copy package files from project root
COPY package*.json ./

# Install npm dependencies
RUN npm install

# Copy only necessary project files (scripts and production code will be mounted at runtime)
COPY . .

# Set NODE_PATH so test scripts can find modules
ENV NODE_PATH=/app/node_modules

# Note: Scripts are mounted as read-only volumes at runtime
# No need to copy or chmod them during build

# Default command
CMD ["/bin/bash"]
