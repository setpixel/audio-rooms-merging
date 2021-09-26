const express = require('express')
const app = express();

// const config = require('./config');
const recordController = require('./controllers/record.controller');

const db = require('./config/db.config.js');

// force: true will drop the table if it already exists
db.sequelize.sync({force: false}).then(() => {
    console.log('Drop and Resync with { force: false }');
}); 


app.get('/mergeall', function(req, res) {
    console.log("merge all")
    recordController.mergeAll("123").then(data => res.json(data));
});

app.listen(3000, () => {
    console.log('merge server is working at :3000 port');
})