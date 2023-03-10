FROM google/cloud-sdk:alpine

ENV BASE_URL="https://get.helm.sh"

ENV HELM_2_FILE="helm-v2.17.0-linux-amd64.tar.gz"
ENV HELM_3_FILE="helm-v3.8.0-linux-amd64.tar.gz"

RUN apk add --no-cache ca-certificates \
    --repository http://dl-3.alpinelinux.org/alpine/edge/community/ \
    jq curl bash nodejs npm aws-cli && \
    apk add --no-cache aws-cli && \
    apk add --no-cache \
        python3 \
        py3-pip \
    && pip3 install --upgrade pip \
    && pip3 install --no-cache-dir \
        awscli \
    && rm -rf /var/cache/apk/* && \
    # Install helm version 2:
    curl -L ${BASE_URL}/${HELM_2_FILE} |tar xvz && \
    mv linux-amd64/helm /usr/bin/helm && \
    chmod +x /usr/bin/helm && \
    rm -rf linux-amd64 && \
    # Install helm version 3:
    curl -L ${BASE_URL}/${HELM_3_FILE} |tar xvz && \
    mv linux-amd64/helm /usr/bin/helm3 && \
    chmod +x /usr/bin/helm3 && \
    rm -rf linux-amd64 && \
    # Init version 2 helm:
    helm init --client-only

RUN \
	gcloud components install kubectl gke-gcloud-auth-plugin \
	&& rm -rf /google-cloud-sdk/.install/.backup \
	&& rm -rf $(find /google-cloud-sdk/ -regex ".*/__pycache__")

ENV PYTHONPATH "/usr/lib/python3.8/site-packages/"

COPY . /usr/src/
WORKDIR /usr/src/

RUN npm ci

ENTRYPOINT ["node", "/usr/src/index.js"]
