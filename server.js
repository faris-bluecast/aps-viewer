const express = require('express');
const fs = require('fs');
const { PORT } = require('./config.js');

let app = express();
app.use(express.static('wwwroot'));
app.use(express.json({ limit: '50mb' }));

const DB_FILE = './annotations.json';
let annotationsDb = [];

if (fs.existsSync(DB_FILE)) {
    try {
        annotationsDb = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        console.error("Error reading annotations db:", e);
    }
}

app.post('/annotations', (req, res) => {
    annotationsDb.push(req.body);
    fs.writeFileSync(DB_FILE, JSON.stringify(annotationsDb, null, 2), 'utf8');
    res.status(201).json({ success: true });
});

app.get('/annotations', (req, res) => {
    const urn = req.query.urn;
    if (urn) {
        res.json(annotationsDb.filter(a => a.urn === urn));
    } else {
        res.json(annotationsDb);
    }
});

app.use(require('./routes/auth.js'));
app.use(require('./routes/models.js'));
app.listen(PORT, function () { console.log(`Server listening on port ${PORT}...`); });
