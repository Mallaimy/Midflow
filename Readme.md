# MediFlow — Hospital Management Platform

## Architecture
3-microservice hospital management system deployed on AWS ECS Fargate.

## Services
| Service | Language | Port |
|---|---|---|
| Patient Service | Python/Flask | 5000 |
| Appointment Service | Node.js/Express | 3000 |
| Notification Service | Node.js/Express | 3001 |

## Tech Stack
- **Cloud:** AWS (ECS Fargate, RDS, SQS, SES, ALB, ECR)
- **IaC:** Terraform
- **CI/CD:** GitHub Actions
- **Containers:** Docker
- **Database:** PostgreSQL (AWS RDS)
- **Messaging:** Amazon SQS
- **Notifications:** Amazon SES
