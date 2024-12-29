const fs = require('fs');
const Docker = require('dockerode');
const docker = new Docker();

const nginxConfigFilePath = './nginx.conf';

// Get the network of dockerreverseproxy-nginx-1
function getNginxNetwork(callback) {
    docker.getContainer('dockerreverseproxy-nginx-1').inspect((err, containerData) => {
        if (err) {
            console.error('Error fetching nginx container data:', err);
            return;
        }

        const networks = containerData.NetworkSettings.Networks;
        if (networks) {
            const networkName = Object.keys(networks)[0];
            callback(networkName);
        } else {
            console.log('No network information available for nginx container.');
        }
    });
}

// Modify the nginx configuration file to add a new upstream and location block
function modifyNginxConfig(containerName, networkName, containerPort) {
    fs.readFile(nginxConfigFilePath, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading nginx config file:', err);
            return;
        }

        // Ensure proper handling of closing brackets
        const cleanedData = data.replace(/\}\s*er\s*X-Forwarded-Proto\s*\$scheme;/g, '}');

        // Regex for finding upstream and location blocks
        const upstreamRegex = /upstream\s+\w+\s+\{\s*[^}]*\}/g;
        const locationRegex = /location\s+\/\w+\s+\{\s*[^}]*\}/g;

        const upstreamExists = new RegExp(`upstream\\s+${containerName}\\s+{`).test(cleanedData);
        const locationExists = new RegExp(`location\\s+/${containerName}\\s+{`).test(cleanedData);

        if (upstreamExists && locationExists) {
            console.log(`Configuration already contains entry for ${containerName}.`);
            return;
        }

        const newUpstream = `
upstream ${containerName} {
    server ${containerName}:${containerPort};
}
        `;

        const newLocation = `
location /${containerName} {
    proxy_pass http://${containerName}/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_redirect off;
}
        `;

        let updatedData = cleanedData;

        const upstreamMatches = cleanedData.match(upstreamRegex);
        if (upstreamMatches) {
            const lastUpstream = upstreamMatches[upstreamMatches.length - 1];
            updatedData = updatedData.replace(lastUpstream, `${lastUpstream}\n${newUpstream}`);
        } else {
            updatedData = `${newUpstream}\n${cleanedData}`;
        }

        const locationMatches = updatedData.match(locationRegex);
        if (locationMatches) {
            const lastLocation = locationMatches[locationMatches.length - 1];
            updatedData = updatedData.replace(lastLocation, `${lastLocation}\n${newLocation}`);
        } else {
            const serverBlockRegex = /server\s+\{[^}]*\}/;
            const serverMatch = updatedData.match(serverBlockRegex);
            if (serverMatch) {
                const serverBlock = serverMatch[0];
                updatedData = updatedData.replace(serverBlock, `${serverBlock}\n${newLocation}`);
            } else {
                updatedData += `\n${newLocation}`;
            }
        }

        fs.writeFile(nginxConfigFilePath, updatedData, 'utf8', (err) => {
            if (err) {
                console.error('Error writing updated nginx config file:', err);
                return;
            }
            console.log(`Nginx config updated with new proxy for ${containerName}`);
            reloadNginx();
        });
    });
}

// Reload Nginx
function reloadNginx() {
    docker.getContainer('dockerreverseproxy-nginx-1').exec({
        AttachStdout: true,
        AttachStderr: true,
        Cmd: ['nginx', '-s', 'reload']
    }, (err, exec) => {
        if (err) {
            console.error('Error reloading nginx:', err);
            return;
        }
        exec.start((err, stream) => {
            if (err) {
                console.error('Error starting exec stream:', err);
                return;
            }
            stream.on('data', (data) => {
                console.log(data.toString());
            });
        });
    });
}

// Monitor Docker containers
function monitorContainers() {
    getNginxNetwork((networkName) => {
        docker.listContainers({ all: false }, (err, containers) => {
            if (err) {
                console.error('Error fetching containers:', err);
                return;
            }

            containers.forEach((container) => {
                const containerName = container.Names[0].replace('/', '');
                const networks = container.NetworkSettings.Networks;

                if (networks && networks[networkName]) {
                    const port = container.Ports.find(p => p.PrivatePort);
                    if (port) {
                        modifyNginxConfig(containerName, networkName, port.PrivatePort);
                    } else {
                        console.log(`No port exposed for container: ${containerName}`);
                    }
                }
            });
        });
    });
}

// Monitor every 10 seconds
setInterval(monitorContainers, 10000);
