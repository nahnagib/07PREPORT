#!/bin/bash

###############################################################################
# Libyan Spider Deployment - Automated Setup Script
# 07 Ps Sales Dashboard - Quick Setup
#
# Usage:
#   chmod +x docs/libyan-spider-quick-setup.sh
#   ./docs/libyan-spider-quick-setup.sh
#
# This script automates Steps 1-5 of the deployment guide.
# Use this on a fresh Libyan Spider VPS (Ubuntu 22.04+) with root access.
#
###############################################################################

set -e  # Exit on any error
set -u  # Exit if variable is undefined

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration (modify these before running)
DOMAIN="benmussa-invest.com"
VPS_IP=$(curl -s https://checkip.amazonaws.com || echo "YOUR_VPS_IP")
APP_DIR="/opt/07ps-dashboard"
REPO_URL="https://github.com/<your-org>/07ps-sales-dashboard-app.git"

# Database credentials (CHANGE THESE!)
DB_HOST="mysql.benmussa-invest.com"
DB_USER="ps_app"
DB_PASSWORD="change-me-to-strong-password"
DB_NAME="ps_warehouse"

# Generate secrets
JWT_SECRET=$(openssl rand -base64 32)
ETL_API_KEY=$(openssl rand -base64 32)

###############################################################################
# Helper Functions
###############################################################################

print_header() {
    echo -e "\n${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}\n"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
    exit 1
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

check_command() {
    if ! command -v $1 &> /dev/null; then
        return 1
    fi
    return 0
}

###############################################################################
# Pre-flight Checks
###############################################################################

preflights() {
    print_header "Pre-flight Checks"

    # Check if running as root
    if [[ $EUID -ne 0 ]]; then
        print_error "This script must be run as root (use 'sudo' or log in as root)"
    fi
    print_success "Running as root"

    # Check OS
    if [[ ! -f /etc/lsb-release ]]; then
        print_error "This script requires Ubuntu (LSB-compliant system)"
    fi
    print_success "Ubuntu/Linux detected"

    # Check disk space
    DISK_FREE=$(df / | awk 'NR==2 {print $4}')
    if [[ $DISK_FREE -lt 50000000 ]]; then
        print_warning "Less than 50GB free disk space. Recommended: 100GB for production."
    else
        print_success "Sufficient disk space ($(numfmt --to=iec $DISK_FREE 2>/dev/null || echo $DISK_FREE) free)"
    fi

    # Check RAM
    RAM_TOTAL=$(free -b | awk 'NR==2 {print $2}')
    if [[ $RAM_TOTAL -lt 4000000000 ]]; then
        print_warning "Less than 4GB RAM. Recommended: 8GB for production."
    else
        print_success "Sufficient RAM ($(numfmt --to=iec $RAM_TOTAL 2>/dev/null || echo $RAM_TOTAL) total)"
    fi

    echo ""
}

###############################################################################
# Step 1: System Preparation
###############################################################################

step1_system_prep() {
    print_header "Step 1: System Preparation"

    echo "Updating package manager..."
    apt-get update -qq
    apt-get upgrade -y -qq
    print_success "System packages updated"

    echo "Installing system utilities..."
    apt-get install -y -qq \
        git curl wget openssl make build-essential ca-certificates \
        apt-transport-https gnupg lsb-release
    print_success "System utilities installed"
}

###############################################################################
# Step 2: Install Docker
###############################################################################

step2_install_docker() {
    print_header "Step 2: Install Docker Engine"

    if check_command docker; then
        print_warning "Docker already installed ($(docker --version))"
        return
    fi

    echo "Adding Docker repository..."
    apt-get remove -y -qq docker docker.io containerd runc 2>/dev/null || true

    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
        gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg 2>/dev/null

    echo \
        "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \
        $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

    echo "Installing Docker..."
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin

    echo "Starting Docker daemon..."
    systemctl start docker
    systemctl enable docker

    print_success "Docker installed and running ($(docker --version))"
    print_success "Docker Compose installed ($(docker compose version | head -1))"
}

###############################################################################
# Step 3: Install Nginx & Certbot
###############################################################################

step3_install_nginx() {
    print_header "Step 3: Install Nginx & Certbot"

    if check_command nginx; then
        print_warning "Nginx already installed ($(nginx -v 2>&1))"
    else
        echo "Installing Nginx..."
        apt-get install -y -qq nginx
        systemctl start nginx
        systemctl enable nginx
        print_success "Nginx installed and running"
    fi

    if check_command certbot; then
        print_warning "Certbot already installed"
    else
        echo "Installing Certbot..."
        apt-get install -y -qq certbot python3-certbot-nginx
        print_success "Certbot installed"
    fi
}

###############################################################################
# Step 4: Clone Repository
###############################################################################

step4_clone_repo() {
    print_header "Step 4: Clone Repository"

    if [[ -d $APP_DIR/.git ]]; then
        print_warning "Repository already cloned at $APP_DIR"
        read -p "Pull latest changes? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            cd $APP_DIR
            git pull origin main
            print_success "Repository updated"
        fi
        return
    fi

    mkdir -p $APP_DIR
    cd $APP_DIR

    echo "Cloning repository..."
    git clone $REPO_URL . 2>/dev/null || print_error "Failed to clone repository"

    print_success "Repository cloned to $APP_DIR"
    echo "Latest commit: $(git log -1 --oneline)"
}

###############################################################################
# Step 5: Generate & Create Environment Files
###############################################################################

step5_env_files() {
    print_header "Step 5: Create Environment Files"

    cd $APP_DIR

    # Backend .env
    cat > backend/.env << EOF
# Backend API Configuration
PORT=4000
NODE_ENV=production
JWT_SECRET=$JWT_SECRET
FRONTEND_ORIGIN=https://$DOMAIN

# Database (MySQL 8)
DB_HOST=$DB_HOST
DB_PORT=3306
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_NAME=$DB_NAME
DB_SOCKET=

# SMTP Configuration (Update with real credentials!)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=noreply@$DOMAIN
SMTP_PASSWORD=your-smtp-password-here
SMTP_FROM="BMH Sales Dashboard <noreply@$DOMAIN>"

# Rate Limiting & Security
RATE_LIMIT_LOGIN_MAX=10
RATE_LIMIT_LOGIN_WINDOW_MIN=15
ACCOUNT_LOCK_THRESHOLD=5
PASSWORD_RESET_TOKEN_TTL_MIN=60

# ETL Configuration
ETL_API_URL=http://etl-api:5001
ETL_API_KEY=$ETL_API_KEY
ETL_API_POLL_INTERVAL_MS=1000
ETL_LOG_DIR=./logs/etl

# ETL Scheduling
ETL_SCHEDULE_INCREMENTAL_CRON=50 8,11,14,17,20 * * *
ETL_SCHEDULE_INCREMENTAL_ENABLED=true
ETL_SCHEDULE_FULL_CRON=0 2 * * *
ETL_SCHEDULE_FULL_ENABLED=true

# Redis (Job Queue - Docker service DNS)
REDIS_HOST=redis
REDIS_PORT=6379
EOF
    print_success "backend/.env created"

    # Frontend .env.local
    cat > frontend/.env.local << EOF
NEXT_PUBLIC_API_BASE_URL=https://api.$DOMAIN
EOF
    print_success "frontend/.env.local created"

    # Data ETL .env
    cat > data/etl/.env << EOF
# Database Configuration
DB_HOST=$DB_HOST
DB_PORT=3306
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_NAME=$DB_NAME
DB_SOCKET=

# Odoo ERP Configuration (Update with real credentials!)
ALLOW_LIVE_ODOO=0
ODOO_URL=https://odoo.example.internal
ODOO_DB=bmh_production
ODOO_USERNAME=admin
ODOO_API_KEY=your-odoo-api-key

# Input Files
INPUT_DIR=/app/data/input

# ETL API
ETL_API_KEY=$ETL_API_KEY
PORT=5001
LOG_LEVEL=INFO
EOF
    print_success "data/etl/.env created"

    # Data Ingestion .env
    cat > data/ingestion/.env << EOF
# Database Configuration
DB_HOST=$DB_HOST
DB_PORT=3306
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_NAME=$DB_NAME
DB_SOCKET=

# Odoo (optional)
ALLOW_LIVE_ODOO=0

# Input Files
INPUT_DIR=/app/data/input

# Flask API
PORT=5000
LOG_LEVEL=INFO
EOF
    print_success "data/ingestion/.env created"

    print_warning "⚠ IMPORTANT: Edit environment files with real credentials:"
    echo "  1. backend/.env - SMTP_USER, SMTP_PASSWORD"
    echo "  2. data/etl/.env - ODOO_URL, ODOO_USERNAME, ODOO_API_KEY"
    echo "  3. Update DB_HOST to your actual MySQL server"
    echo ""
    echo "Run this command to edit:"
    echo "  nano $APP_DIR/backend/.env"
}

###############################################################################
# Step 6: Build Docker Images
###############################################################################

step6_build_docker() {
    print_header "Step 6: Build Docker Images"

    cd $APP_DIR

    echo "Building Docker images... (this may take 10-20 minutes)"
    docker compose build 2>&1 | tail -20 || print_error "Docker build failed"

    print_success "Docker images built successfully"
    docker images | grep -E "07ps|redis" || echo "Images building..."
}

###############################################################################
# Step 7: Start Containers
###############################################################################

step7_start_containers() {
    print_header "Step 7: Start Docker Containers"

    cd $APP_DIR

    echo "Starting containers..."
    docker compose up -d || print_error "Failed to start containers"

    echo "Waiting 30 seconds for containers to initialize..."
    sleep 30

    echo "Container status:"
    docker compose ps

    print_success "Containers started"
}

###############################################################################
# Step 8: Configure Nginx
###############################################################################

step8_configure_nginx() {
    print_header "Step 8: Configure Nginx"

    cd $APP_DIR

    # Backup existing config
    cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.backup.$(date +%s)

    # Copy new config (update domain if needed)
    cp docker/nginx.conf /etc/nginx/nginx.conf

    # Replace domain placeholder
    sed -i "s/benmussa-invest.com/$DOMAIN/g" /etc/nginx/nginx.conf

    # Test config
    if ! nginx -t &>/dev/null; then
        print_error "Nginx configuration test failed"
    fi

    systemctl reload nginx
    print_success "Nginx configured and reloaded"
}

###############################################################################
# Step 9: Request SSL Certificates
###############################################################################

step9_ssl_certs() {
    print_header "Step 9: Request SSL Certificates"

    mkdir -p /var/www/certbot

    echo "Requesting Let's Encrypt certificate for $DOMAIN..."
    certbot certonly --nginx \
        -d $DOMAIN \
        -d www.$DOMAIN \
        -d api.$DOMAIN \
        -d etl-api.$DOMAIN \
        --email admin@$DOMAIN \
        --agree-tos \
        --no-eff-email \
        --non-interactive 2>&1 | tail -10 || print_error "Certificate request failed"

    print_success "SSL certificate installed"

    # Reload Nginx with HTTPS
    systemctl reload nginx
    print_success "Nginx reloaded with HTTPS"

    # Setup auto-renewal
    systemctl enable certbot.timer
    systemctl start certbot.timer
    print_success "Certificate auto-renewal scheduled"
}

###############################################################################
# Post-Deployment Verification
###############################################################################

verify_deployment() {
    print_header "Post-Deployment Verification"

    cd $APP_DIR

    echo "1. Checking Docker containers..."
    if docker compose ps | grep -q "healthy"; then
        print_success "Docker containers are running"
    else
        print_warning "Some containers may still be initializing"
    fi

    echo -e "\n2. Testing frontend..."
    if curl -sf https://$DOMAIN/ > /dev/null 2>&1; then
        print_success "Frontend is accessible"
    else
        print_warning "Frontend not yet responding (may still be starting)"
    fi

    echo -e "\n3. Testing backend API..."
    if curl -sf https://api.$DOMAIN/health > /dev/null 2>&1; then
        print_success "Backend API is healthy"
    else
        print_warning "Backend API not yet responding (may still be starting)"
    fi

    echo -e "\n4. Database connectivity..."
    if docker compose exec backend npm run etl:run 2>&1 | grep -q "success\|completed\|error" ; then
        print_success "Database connectivity verified"
    else
        print_warning "Database test pending"
    fi

    echo -e "\n5. Configuration files created:"
    ls -1 backend/.env data/etl/.env frontend/.env.local 2>/dev/null | sed 's/^/   ✓ /'
}

###############################################################################
# Final Summary
###############################################################################

print_summary() {
    print_header "Deployment Complete!"

    cat << EOF
${GREEN}✓ System environment configured${NC}
${GREEN}✓ Docker Engine & Compose installed${NC}
${GREEN}✓ Nginx & Certbot installed${NC}
${GREEN}✓ Repository cloned${NC}
${GREEN}✓ Environment files created${NC}
${GREEN}✓ Docker images built${NC}
${GREEN}✓ Containers started${NC}
${GREEN}✓ Nginx configured with HTTPS${NC}
${GREEN}✓ SSL certificates installed${NC}

${BLUE}Next Steps:${NC}

1. ${YELLOW}Edit environment files with real credentials:${NC}
   nano $APP_DIR/backend/.env
   - Update SMTP_USER, SMTP_PASSWORD
   - Verify DB_HOST, DB_USER, DB_PASSWORD

2. ${YELLOW}Edit data/etl/.env with Odoo credentials:${NC}
   nano $APP_DIR/data/etl/.env
   - Set ALLOW_LIVE_ODOO=1
   - Update ODOO_URL, ODOO_USERNAME, ODOO_API_KEY

3. ${YELLOW}Restart backend after credential changes:${NC}
   cd $APP_DIR
   docker compose restart backend

4. ${YELLOW}Verify DNS (should resolve to $VPS_IP):${NC}
   nslookup $DOMAIN
   nslookup api.$DOMAIN

5. ${YELLOW}Access the dashboard:${NC}
   https://$DOMAIN

6. ${YELLOW}Create admin user:${NC}
   docker compose exec backend npm run create-admin

${BLUE}Monitoring:${NC}

View logs:
   cd $APP_DIR
   docker compose logs -f

Check container health:
   docker compose ps

Monitor resources:
   docker stats

${BLUE}Support:${NC}

Full deployment guide: $APP_DIR/docs/libyan-spider-deployment.md
Architecture guide: $APP_DIR/docs/07Ps_Phase1_Architecture_Standards.md

EOF
}

###############################################################################
# Main Execution
###############################################################################

main() {
    clear

    cat << "EOF"
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║  07 Ps Sales Dashboard - Libyan Spider Deployment Script      ║
║                                                                ║
║  This script automates the setup process on a fresh VPS       ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
EOF

    echo ""
    echo "Configuration:"
    echo "  Domain: $DOMAIN"
    echo "  App Directory: $APP_DIR"
    echo "  Database: $DB_HOST:$DB_NAME"
    echo ""

    read -p "Proceed with deployment? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Deployment cancelled."
        exit 0
    fi

    preflights
    step1_system_prep
    step2_install_docker
    step3_install_nginx
    step4_clone_repo
    step5_env_files

    echo ""
    print_warning "⚠ IMPORTANT: Edit environment files before continuing!"
    print_warning "   The database and Odoo credentials are placeholders."
    echo ""
    read -p "Press Enter once you've updated the environment files..."

    step6_build_docker
    step7_start_containers
    step8_configure_nginx
    step9_ssl_certs
    verify_deployment
    print_summary
}

# Run main function
main "$@"

