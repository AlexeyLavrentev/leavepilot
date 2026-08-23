'use strict';

const listen = ({app, port, host}) => new Promise((resolve, reject) => {
  const server = app.listen(port, host, error => {
    if (error) {
      reject(error);
      return;
    }
    resolve(server);
  });
});

module.exports = {
  listen,
};
