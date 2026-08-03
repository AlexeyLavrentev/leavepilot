# Доверие к локальному CA пилота

Публичный корневой сертификат:

```text
leavepilot-pilot-ca.crt
```

Ожидаемый SHA-256 fingerprint:

```text
EB:58:76:EA:C8:DF:3A:18:BD:F2:0A:82:4B:05:81:1E:C3:85:E0:C2:22:EF:14:79:FC:28:CC:F5:07:EA:D6:74
```

Перед импортом обязательно сравнить fingerprint. Приватный ключ CA на
пользовательские компьютеры не передаётся.

## Windows 10/11

Запустить PowerShell от имени администратора в каталоге с сертификатом:

```powershell
$certificate = Import-Certificate `
  -FilePath .\leavepilot-pilot-ca.crt `
  -CertStoreLocation Cert:\LocalMachine\Root
$certificate.Thumbprint
```

Ожидаемый thumbprint без двоеточий:

```text
EB5876EAC8DF3A18BDF20A824B05811EC385E0C222EF1479FC28CCF507EAD674
```

Chrome и Edge используют системное хранилище Windows. Их нужно полностью
закрыть и открыть после импорта сертификата.

## Ubuntu/Debian/Astra Linux

```bash
openssl x509 -in leavepilot-pilot-ca.crt -noout -fingerprint -sha256
sudo install -m 644 leavepilot-pilot-ca.crt \
  /usr/local/share/ca-certificates/sdigital-leavepilot-pilot-ca.crt
sudo update-ca-certificates
```

Имя находится в зоне `.local`, которую `systemd-resolved` может направлять в
mDNS вместо корпоративного DNS. Если `dig` к корпоративному DNS возвращает
адрес, а `getent hosts vacation-pilot.sdigital.local` — нет, администратор сети
должен добавить для интерфейса route-only domain `~sdigital.local` либо выбрать
корпоративное имя вне `.local`. Не отключать `systemd-resolved` ради пилота.

## macOS

Проверить fingerprint, затем выполнить от имени администратора:

```bash
openssl x509 -in leavepilot-pilot-ca.crt -noout -fingerprint -sha256
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain leavepilot-pilot-ca.crt
```

## Firefox

Если Firefox не использует системные корневые сертификаты, импортировать
`leavepilot-pilot-ca.crt` через:

```text
Settings → Privacy & Security → Certificates → View Certificates → Authorities
```

Разрешить доверие только для идентификации веб-сайтов.

## Проверка после запуска пилота

```bash
curl -I https://vacation-pilot.sdigital.local/
openssl s_client \
  -connect vacation-pilot.sdigital.local:443 \
  -servername vacation-pilot.sdigital.local \
  -verify_return_error </dev/null
```

Ожидается успешная TLS-проверка без `-k`/`--insecure`. Пока DNS-имя не
разрешается и пилотный virtual host не включён, эта проверка ожидаемо не
пройдёт.

## Правила обращения с CA

- распространяется только публичный файл `leavepilot-pilot-ca.crt`;
- приватный ключ CA хранится только на выделенной резервной машине с правами
  `600`;
- CA используется только для пилотной внутренней инфраструктуры;
- серверный сертификат действует один год и должен быть перевыпущен до
  16 июля 2027 года;
- при компрометации CA доверие к нему удаляется со всех тестовых устройств и
  выпускается новый CA.
