#! /bin/bash

# curl https://npkproject.io/cloudshell_install_dev.sh | bash

NODE_VERSION=20.19.2

if [[ $UID -eq 0 ]]; then
	echo "[!] Don't run this as root."
	return 1
fi

# install compiler, cmake3, and 7z
if [[ ! -f /usr/bin/cmake ]]; then
	echo "[*] Installing CMake3, C++, and dependencies"
	sudo yum install -y --allowerasing cmake3 gcc-c++ jq curl tar xz > /dev/null
	sudo ln -s /usr/bin/cmake3 /usr/bin/cmake
fi

# Download latest 7-Zip binary from GitHub if not already installed
if [[ ! -f /usr/local/bin/7z ]]; then
	echo "[*] Installing latest 7-Zip from GitHub"
	LATEST_7Z_RELEASE=$(curl -s https://api.github.com/repos/ip7z/7zip/releases/latest | jq -r '.tag_name' 2>/dev/null)

	if [[ -n "$LATEST_7Z_RELEASE" && "$LATEST_7Z_RELEASE" != "null" ]]; then
		LATEST_7Z_VERSION=$(echo $LATEST_7Z_RELEASE | tr -d '.')

		# Detect architecture
		if [[ $(uname -m) == "aarch64" ]]; then
			DOWNLOAD_URL="https://github.com/ip7z/7zip/releases/download/$LATEST_7Z_RELEASE/7z${LATEST_7Z_VERSION}-linux-arm64.tar.xz"
		else
			DOWNLOAD_URL="https://github.com/ip7z/7zip/releases/download/$LATEST_7Z_RELEASE/7z${LATEST_7Z_VERSION}-linux-x64.tar.xz"
		fi

		if curl -L -o /tmp/7z.tar.xz "$DOWNLOAD_URL" 2>/dev/null && tar -xf /tmp/7z.tar.xz -C /tmp/ 2>/dev/null && [ -f /tmp/7zz ]; then
			sudo mv /tmp/7zz /usr/local/bin/7z
			sudo chmod +x /usr/local/bin/7z
			sudo ln -sf /usr/local/bin/7z /usr/local/bin/7za
			rm -f /tmp/7z.tar.xz
			echo "[+] 7-Zip $LATEST_7Z_RELEASE installed successfully"
		else
			echo "[!] Failed to download 7-Zip from GitHub, falling back to p7zip"
			sudo yum install -y --allowerasing p7zip p7zip-plugins > /dev/null
		fi
	else
		echo "[!] Failed to fetch 7-Zip release info, falling back to p7zip"
		sudo yum install -y --allowerasing p7zip p7zip-plugins > /dev/null
	fi
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
	git clone https://github.com/c6fc/npk.git /aws/mde/npk > /dev/null
fi

# Run the deploy:
cd /aws/mde/npk
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

echo
echo "================================================================================"
echo "[+] Deployment complete!"
echo "================================================================================"
echo

cd /aws/mde/npk
export PS1="\e[1m\e[32m@c6fc/npk>\e[0m "

# Use return if sourced, exit if executed
(return 0 2>/dev/null) && return 0 || exit 0