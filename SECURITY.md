# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately using GitHub's private vulnerability reporting: go to the [Security tab](https://github.com/thomasschafer/workshop/security) of this repository and select "Report a vulnerability". Don't open a public issue, pull request or discussion for a suspected vulnerability.

Include as much of the following as you can:

- what an attacker can do, and what they need (network access, a crafted config file, and so on)
- steps or a proof of concept to reproduce it
- the Workshop version (`workshop --version`) and your operating system

You should get an acknowledgement within a week. Once a fix is released, the advisory will be published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Only the latest release receives security fixes.

## Scope

The Workshop server runs arbitrary code on your machine and spends your model subscription, so anyone who can reach it effectively has a shell. Issues that are in scope include:

- bypassing authentication, or using the server without a valid token
- the server listening beyond localhost or your tailnet without being explicitly configured to
- command injection, whether through configuration, puzzle content, or model output
- reading or writing files outside the directories Workshop is meant to use
- leaking secrets such as your Workshop token or Advent of Code session cookie

Out of scope:

- anything that requires an attacker to already have a valid token, or to control your shell or user account
- code you or the model deliberately run through Workshop doing what it was asked to do
- vulnerabilities in dependencies that Workshop doesn't expose, which should be reported upstream
