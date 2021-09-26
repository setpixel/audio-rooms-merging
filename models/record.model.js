module.exports = (sequelize, Sequelize) => {
    const Record = sequelize.define('record', {
        id: {
            type: Sequelize.INTEGER,
            autoIncrement: true,
            primaryKey: true
        },
        filename: {
            type: Sequelize.STRING
        },
        username: {
            type: Sequelize.STRING
        },
        roomname: {
            type: Sequelize.STRING
        },
        starttime: {
            type: Sequelize.STRING
        },
        avartar: {
            type: Sequelize.STRING
        },
        record: {
            type: Sequelize.STRING
        },
        recordtype: {
            type: Sequelize.STRING
        },
        mergestatus: {
            type: Sequelize.STRING
        }
    });

    return Record;
}