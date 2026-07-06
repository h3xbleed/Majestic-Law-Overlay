// тянет базу законов в app/data (из docs/ если есть, иначе с github)
const fs = require('fs');
const path = require('path');
const DST = path.resolve(__dirname, '..', 'app', 'data');
const LOCAL = path.resolve(__dirname, '..', 'docs', 'app', 'data');
if (fs.existsSync(LOCAL)) {
  fs.cpSync(LOCAL, DST, {recursive: true});
  console.log('база скопирована из docs/');
} else {
  console.log('нет локальной базы; скачай db из репо majestic-law-db в app/data');
}
