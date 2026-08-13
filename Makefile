SHELL := /bin/sh

COMPOSE ?= docker compose

.PHONY: up stop rebuild

up:
	$(COMPOSE) up -d

stop:
	$(COMPOSE) stop

rebuild:
	$(COMPOSE) build --no-cache
	$(COMPOSE) up -d --force-recreate
