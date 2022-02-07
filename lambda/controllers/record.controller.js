const child_process = require('child_process');
const spawn = require('await-spawn');
const aws = require('aws-sdk');
const fs = require('fs');
const env = require('../config/env.js');

aws.config.update({
  secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  accessKeyId: env.AWS_ACCESS_KEY,
  region: env.AWS_REGION
});

const s3 = new aws.S3({
  signatureVersion: "v4",
});

const db = require('../config/db.config');
const RecordModel = db.Record;

const RECORD_FILE_LOCATION_PATH = process.env.RECORD_FILE_LOCATION_PATH || './public/files';

exports.addNewRecord = async (username, roomname, filename, starttime) => {

  await spawn('ffmpeg', [
    `-i ${RECORD_FILE_LOCATION_PATH}/${filename}`,
    `-vn`,
    `-ab 128k`,
    `-ar 44100`,
    `-y ${RECORD_FILE_LOCATION_PATH}/${starttime}.mp3`
  ], {
    detached: false,
    shell: true
  });

  const recordInfo = {
    filename: filename,
    username: username,
    roomname: roomname,
    starttime: starttime,
    avartar: '',
    record: `${RECORD_FILE_LOCATION_PATH}/${starttime}.mp3`,
    recordtype: 'individual', // individual, total
    mergestatus: 'no', // 'yes': merged, 'no': not merged
  }

  const record = await RecordModel.create(recordInfo);

  // await this.mergeAll(roomname);

  uploadFileToS3(roomname, starttime);
  return record;
}

exports.mergeAll = async (roomname) => {
  const recordstomerge = await RecordModel.findAll({
    where: {
      recordtype: "individual",
      mergestatus: "no",
      roomname: roomname
    },
    order: [
      ['starttime', 'ASC']
    ],
    row: true
  }).then(rows => {
    return rows.map(r => {
      return r.dataValues;
    })
  });

  const totaltomerge = await RecordModel.findOne({
    where: {
      recordtype: "total",
      roomname: roomname
    },
    row: true
  });

  if (totaltomerge) {
    mergefirst = totaltomerge.record;
    for (var i = 0; i < recordstomerge.length; i++) {
      delaytime = Math.ceil((recordstomerge[i].starttime - totaltomerge.starttime) / 1000);
      await spawn("ffmpeg", [
        `-i ${mergefirst}`,
        `-i ${recordstomerge[i].record}`,
        `-filter_complex "[1]adelay=${delaytime}s|${delaytime}s[a1];[0:a][a1]amix=inputs=2[a]"`,
        `-map "[a]"`,
        `${RECORD_FILE_LOCATION_PATH}/${roomname}-${recordstomerge[i].id}.mp3`
      ], {
        detached: false,
        shell: true
      });

      await RecordModel.update({
        mergestatus: 'yes'
      }, {
        where: {
          id: [recordstomerge[i].id]
        }
      });

      await RecordModel.update({
        record: `${RECORD_FILE_LOCATION_PATH}/${roomname}-${recordstomerge[i].id}.mp3`,
        filename: `${roomname}-${recordstomerge[i].id}.mp3`
      }, {
        where: {
          id: [totaltomerge.id]
        }
      });

      mergefirst = `${RECORD_FILE_LOCATION_PATH}/${roomname}-${recordstomerge[i].id}.mp3`;
    }
  } else {
    delaytime = Math.ceil((recordstomerge[1].starttime - recordstomerge[0].starttime) / 1000);
    await spawn("ffmpeg", [
      `-i ${recordstomerge[0].record}`,
      `-i ${recordstomerge[1].record}`,
      `-filter_complex "[1]adelay=${delaytime}s|${delaytime}s[a1];[0:a][a1]amix=inputs=2[a]"`,
      `-map "[a]"`,
      `${RECORD_FILE_LOCATION_PATH}/${roomname}-${recordstomerge[1].id}.mp3`
    ], {
      detached: false,
      shell: true
    });

    await RecordModel.update({
      mergestatus: 'yes'
    }, {
      where: {
        id: [recordstomerge[0].id, recordstomerge[1].id]
      }
    });

    const recordInfo = {
      filename: `${roomname}-${recordstomerge[1].id}.mp3`,
      username: 'system',
      roomname: roomname,
      starttime: recordstomerge[0].starttime,
      avartar: '',
      record: `${RECORD_FILE_LOCATION_PATH}/${roomname}-${recordstomerge[1].id}.mp3`,
      recordtype: 'total', // individual, total
      mergestatus: 'yes', // 'yes': merged, 'no': not merged
    }

    const totalrecord = await RecordModel.create(recordInfo);

    for (var i = 2; i < recordstomerge.length; i++) {
      delaytime = Math.ceil((recordstomerge[i].starttime - recordstomerge[0].starttime) / 1000);
      await spawn("ffmpeg", [
        `-i ${RECORD_FILE_LOCATION_PATH}/${roomname}-${recordstomerge[i-1].id}.mp3`,
        `-i ${recordstomerge[i].record}`,
        `-filter_complex "[1]adelay=${delaytime}s|${delaytime}s[a1];[0:a][a1]amix=inputs=2[a]"`,
        `-map "[a]"`,
        `${RECORD_FILE_LOCATION_PATH}/${roomname}-${recordstomerge[i].id}.mp3`
      ], {
        detached: false,
        shell: true
      });

      await RecordModel.update({
        mergestatus: 'yes'
      }, {
        where: {
          id: [recordstomerge[i].id]
        }
      });

      await RecordModel.update({
        record: `${RECORD_FILE_LOCATION_PATH}/${roomname}-${recordstomerge[i].id}.mp3`,
        filename: `${roomname}-${recordstomerge[i].id}.mp3`
      }, {
        where: {
          id: [totalrecord.id]
        }
      });
    }
  }

  return totaltomerge;
}


exports.getAllRecords = async () => {
  const records = await RecordModel.findAll({
    where: {
      recordtype: "total"
    },
    order: [
      ['starttime', 'ASC']
    ],
    row: true
  }).then(rows => {
    return rows.map(r => {
      return r.dataValues;
    })
  });

  return records;
}


function uploadFileToS3(roomname, starttime) {
  try {
    const fileContent = fs.readFileSync(`${RECORD_FILE_LOCATION_PATH}/${starttime}.mp3`);
    const params = {
      Bucket: env.AWS_BUCKET_NAME,
      Key: roomname + '/' + starttime + '.mp3',
      Body: fileContent,
      ACL: 'public-read'
    };

    s3.upload(params, function (error, data) {
      if (error) {
        throw error;
      }

      console.log(data)
    });
  } catch (e) {
    console.log(e)
  }

}