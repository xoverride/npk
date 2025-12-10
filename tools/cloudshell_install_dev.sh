#! /bin/bash

# curl https://npkproject.io/cloudshell_install_dev.sh | bash

TF_CLI_ARGS_apply="-parallelism=1"
NODE_OPTIONS="--max-old-space-size=1536"
NODE_VERSION=20.19.2

if [[ $UID -eq 0 ]]; then
        echo "[!] Don't run this as root."
        return 1
fi

# install compiler and cmake3, aliased to cmake
if [[ ! -f /usr/bin/cmake ]]; then
        echo "[*] Installing CMake3, C++"
        sudo yum install -y cmake3 gcc-c++ > /dev/null
        sudo ln -s /usr/bin/cmake3 /usr/bin/cmake
fi

# install nvm and node
if [[ ! -d /aws/mde/nvm ]]; then
        echo "[*] Installing NVM"
        sudo mkdir /aws/mde/nvm
        sudo chown cloudshell-user:cloudshell-user /aws/mde/nvm

        sudo ln -s /aws/mde/nvm ~/.nvm
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | bash > /dev/null
fi

export NVM_DIR="/aws/mde/nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

echo "[*] Installing node.js ${NODE_VERSION}"
nvm install $NODE_VERSION > /dev/null
nvm alias default $NODE_VERSION
nvm use $NODE_VERSION

# Set up the larger storage environment:
if [[ ! -d /aws/mde/npk ]]; then
        sudo mkdir /aws/mde/npk
        sudo chown cloudshell-user:cloudshell-user /aws/mde/npk
fi

# Pull the repo:
if [[ ! -f /aws/mde/npk/README.md ]]; then
        echo "[*] Cloning the NPK repo"
        git clone https://github.com/xoverride/npk.git /aws/mde/npk > /dev/null
fi

# Run the deploy:
cd /aws/mde/npk
git checkout checkpoint-resume
git pull

echo
echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
echo "[+] Installing Node.js prerequisites. This can take up to two minutes, and may appear frozen. DON'T INTERRUPT IT."
echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
echo
echo

export INIT_CWD="$PWD"
npm install > /dev/null

bash -c "exec node bin/index.js deploy -y < /dev/tty"

# ============================================================================================
# NEW: Build and upload updated compute-node.7z with checkpoint/resume support
# ============================================================================================

echo
echo "================================================================================"
echo "[*] Building and uploading updated compute-node.7z with checkpoint/resume support"
echo "================================================================================"
echo

cd /aws/mde/npk/tools

# Check if 7z is installed, if not install it
if ! command -v 7z &> /dev/null; then
    echo "[*] Installing p7zip for building components..."
    sudo yum install -y p7zip p7zip-plugins > /dev/null
fi

# Build compute-node.7z with updated code
echo "[*] Building compute-node.7z from tools/compute-node/..."
if [[ -d compute-node ]]; then
    # Install dependencies first (node_modules is in .gitignore)
    echo "[*] Installing compute-node dependencies..."
    cd compute-node
    npm install > /dev/null 2>&1
    cd ..

    # Create components directory if it doesn't exist
    mkdir -p components

    # Build the archive (same as upload_npkcomponents.sh.tpl line 32)
    7z a components/compute-node.7z compute-node/ > /dev/null

    if [[ $? -eq 0 ]]; then
        echo "[+] compute-node.7z built successfully"

        # Get dictionary bucket name from terraform output or terraform directory
        cd /aws/mde/npk/terraform

        BUCKET=""

        # Try terraform output first
        if command -v terraform &> /dev/null; then
            BUCKET=$(terraform output -raw aws_s3_bucket.dictionary.id 2>/dev/null)
        fi

        # Fallback to dictionaries.auto.tfvars
        if [[ -z "$BUCKET" ]] && [[ -f dictionaries.auto.tfvars ]]; then
            BUCKET=$(grep dictionaryBucket dictionaries.auto.tfvars | cut -d'"' -f2)
        fi

        # Last resort: search for npk-dictionary bucket
        if [[ -z "$BUCKET" ]]; then
            BUCKET=$(aws s3 ls | grep npk-dictionary | head -n1 | awk '{print $3}')
        fi

        if [[ -n "$BUCKET" ]]; then
            # Compute local file MD5 hash
            echo "[*] Computing local file checksum..."
            LOCAL_MD5=$(md5sum /aws/mde/npk/tools/components/compute-node.7z | awk '{print $1}')

            # Get S3 object ETag (MD5 hash) without downloading
            echo "[*] Checking S3 object checksum..."
            S3_ETAG=$(aws s3api head-object --bucket "$BUCKET" --key "components-v3/compute-node.7z" --query 'ETag' --output text 2>/dev/null | tr -d '"')

            # Compare checksums
            if [[ -n "$S3_ETAG" ]] && [[ "$LOCAL_MD5" == "$S3_ETAG" ]]; then
                echo "[+] Local file matches S3 object (checksum: $LOCAL_MD5)"
                echo "[+] Skipping upload - compute-node.7z is already up to date"
            else
                if [[ -n "$S3_ETAG" ]]; then
                    echo "[*] Checksums differ (local: $LOCAL_MD5, S3: $S3_ETAG)"
                else
                    echo "[*] No existing S3 object found"
                fi

                echo "[*] Uploading to s3://$BUCKET/components-v3/compute-node.7z..."
                aws s3 cp /aws/mde/npk/tools/components/compute-node.7z s3://$BUCKET/components-v3/compute-node.7z

                if [[ $? -eq 0 ]]; then
                    echo "[+] Successfully uploaded updated compute-node.7z"
                    echo "[+] New EC2 instances will now use the updated code with checkpoint/resume support"

                    # Verify upload
                    aws s3 ls s3://$BUCKET/components-v3/ | grep compute-node.7z
                else
                    echo "[!] WARNING: Failed to upload compute-node.7z to S3"
                    echo "[!] You may need to upload manually:"
                    echo "    aws s3 cp /aws/mde/npk/tools/components/compute-node.7z s3://$BUCKET/components-v3/compute-node.7z"
                fi
            fi
        else
            echo "[!] WARNING: Could not determine dictionary bucket name"
            echo "[!] Please upload compute-node.7z manually:"
            echo "    BUCKET=\$(aws s3 ls | grep npk-dictionary | awk '{print \$3}')"
            echo "    aws s3 cp /aws/mde/npk/tools/components/compute-node.7z s3://\$BUCKET/components-v3/compute-node.7z"
        fi

        # Clean up temporary file
        rm -f /aws/mde/npk/tools/components/compute-node.7z
    else
        echo "[!] WARNING: Failed to build compute-node.7z"
        echo "[!] Checkpoint/resume functionality may not work correctly"
    fi
else
    echo "[!] WARNING: compute-node directory not found at /aws/mde/npk/tools/compute-node/"
    echo "[!] Skipping component build"
fi

echo
echo "================================================================================"
echo "[+] Deployment and component upload complete!"
echo "================================================================================"
echo

cd /aws/mde/npk
export PS1="\e[1m\e[32m@c6fc/npk>\e[0m "
return 0
