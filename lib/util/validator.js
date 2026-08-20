'use strict';

// Обёртка-совместимость поверх validator@13.
//
// validator@13 бросает TypeError, если на вход подаётся не строка, тогда как
// устаревший validator@3, на который рассчитан код, молча приводил вход к строке.
// Здесь это мягкое поведение восстановлено, чтобы существующие вызовы вида
// validator.trim(req.body['x']) (где x может быть undefined) продолжали работать.
//
// Дополнительно isDate оставлен терпимым к форматам дат, которые использует
// приложение, включая DD.MM.YYYY для компаний KZ/RU.

const validator = require('validator');
const dayjs = require('./date');

function toStr(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : String(value);
}

// Методы, принимающие строку первым аргументом и исторически терпевшие
// не-строки. Оборачиваем, приводя первый аргумент к строке.
const STRING_METHODS = [
  'trim', 'isNumeric', 'toBoolean', 'isInt', 'matches',
  'isEmail', 'isFloat', 'toInt', 'isFQDN', 'isAlphanumeric',
];

const wrapped = Object.assign({}, validator);

STRING_METHODS.forEach(function (name) {
  const original = validator[name];
  wrapped[name] = function (str) {
    const args = Array.prototype.slice.call(arguments);
    args[0] = toStr(str);
    return original.apply(validator, args);
  };
});

// Форматы дат, принимаемые приложением (отображаемые форматы + ISO).
const DATE_FORMATS = [
  'YYYY-MM-DD', 'YYYY/MM/DD',
  'DD/MM/YYYY', 'DD.MM.YYYY', 'DD-MM-YYYY',
  'MM/DD/YYYY',
  'YYYY-MM-DDTHH:mm:ss.SSSZ',
  'YYYY-MM-DDTHH:mm:ssZ',
  'YYYY-MM-DDTHH:mm:ss',
];

// validator@13 isDate отвергает DD/MM/YYYY и DD.MM.YYYY. Заменяем на строгий
// разбор moment по списку известных форматов — это сохраняет мягкое поведение
// validator@3 и корректно принимает наши локализованные форматы.
wrapped.isDate = function (str) {
  const s = toStr(str);
  if (!s) return false;
  return dayjs(s, DATE_FORMATS, true).isValid();
};

module.exports = wrapped;
